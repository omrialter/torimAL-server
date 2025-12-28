const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const router = express.Router();

// Internal Imports
const { BlockModel, validateBlock } = require("../models/blockModel");
const { auth, authAdmin } = require("../auth/auth");

// Constants
const BLOCK_REASONS = ["vacation", "maintenance", "training", "other"];

// Helper
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Update Schema (PATCH)
 * Allows partial updates
 */
const updateBlockSchema = Joi.object({
    resource: Joi.string().hex().length(24).allow(null),
    start: Joi.date().iso(),
    end: Joi.date().iso().greater(Joi.ref("start")),
    timezone: Joi.string(),
    reason: Joi.string().valid(...BLOCK_REASONS),
    notes: Joi.string().max(1000).allow("", null),
    active: Joi.boolean(),
}).min(1); // Require at least one field to update

/* ======================================================
   📅 GET BLOCKS BY DAY
   Used by the appointment scheduler.
   Returns blocks for a specific date, filtering by business AND (worker OR global).
   GET /blocks/by-day?date=YYYY-MM-DD&worker=xxxxx
====================================================== */
router.get("/by-day", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { date, worker } = req.query;

        if (!isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid business ID" });
        }

        if (!date) {
            return res.status(400).json({ error: "Missing required query param: date (YYYY-MM-DD)" });
        }

        const dayStart = new Date(date);
        if (Number.isNaN(dayStart.getTime())) {
            return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
        }

        // Calculate end of the day
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        // Base Filter: Active blocks in this business overlapping the day
        const filter = {
            business,
            active: true,
            start: { $lt: dayEnd },
            end: { $gt: dayStart },
        };

        // Worker Filter:
        // If a worker ID is provided, fetch blocks specific to that worker OR global business blocks.
        // If no worker is provided, fetch ONLY global business blocks.
        if (worker && isValidObjectId(worker)) {
            filter.$or = [{ resource: null }, { resource: worker }];
        } else {
            filter.resource = null;
        }

        const blocks = await BlockModel.find(filter).sort({ start: 1 });
        res.json(blocks);
    } catch (err) {
        console.error("GET /blocks/by-day error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   📜 GET BLOCKS LIST (Admin Dashboard)
   GET /blocks/list?resource=...&worker=...&from=...&to=...&includeInactive=true
====================================================== */
router.get("/list", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { resource, worker, from, to, includeInactive } = req.query;

        if (!isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid business ID" });
        }

        const filter = { business };

        // Default: Return only active blocks unless specified
        if (includeInactive !== "true") {
            filter.active = true;
        }

        // Date Range Filter
        if (from || to) {
            filter.start = {};
            if (from) filter.start.$gte = new Date(from);
            if (to) {
                const endDate = new Date(to);
                endDate.setDate(endDate.getDate() + 1); // Include the whole 'to' day
                filter.start.$lt = endDate;
            }
        }

        // Resource Logic
        if (worker && isValidObjectId(worker)) {
            // Return global blocks + this specific worker's blocks
            filter.$or = [{ resource: null }, { resource: worker }];
        } else if (resource) {
            // Strict filtering
            if (resource === "null") {
                filter.resource = null;
            } else if (isValidObjectId(resource)) {
                filter.resource = resource;
            }
        }

        const blocks = await BlockModel.find(filter).sort({ start: 1 });
        res.json(blocks);
    } catch (err) {
        console.error("GET /blocks/list error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   ➕ CREATE BLOCK
   POST /blocks
====================================================== */
router.post("/", authAdmin, async (req, res) => {
    try {
        const { business, _id: userId } = req.tokenData;

        const payload = {
            ...req.body,
            business,
            createdBy: userId,
        };

        const valid = validateBlock(payload);
        if (valid.error) {
            return res.status(400).json({
                error: "Validation error",
                details: valid.error.details.map((d) => d.message),
            });
        }

        const block = new BlockModel(valid.value);
        await block.save();

        res.status(201).json(block);
    } catch (err) {
        console.error("POST /blocks error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   ✏️ UPDATE BLOCK
   PATCH /blocks/:id
====================================================== */
router.patch("/:id", authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: "Invalid block ID" });
        }

        const { error, value } = updateBlockSchema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true,
        });

        if (error) {
            return res.status(400).json({
                error: "Validation error",
                details: error.details.map((d) => d.message),
            });
        }

        const updated = await BlockModel.findOneAndUpdate(
            { _id: id, business },
            value,
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ error: "Block not found" });
        }

        res.json(updated);
    } catch (err) {
        console.error("PATCH /blocks/:id error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   🗑 DELETE BLOCK (Soft Delete)
   DELETE /blocks/:id
====================================================== */
router.delete("/:id", authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: "Invalid block ID" });
        }

        // Soft delete: set active to false
        const updated = await BlockModel.findOneAndUpdate(
            { _id: id, business },
            { active: false },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ error: "Block not found" });
        }

        res.json({ msg: "Block deleted", block: updated });
    } catch (err) {
        console.error("DELETE /blocks/:id error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;