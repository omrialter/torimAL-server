// routes/blocks.js
const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const { BlockModel, validateBlock } = require("../models/blockModel");
const { auth, authAdmin } = require("../auth/auth");

const router = express.Router();

/**
 * סיבות אפשריות (שיהיו מסונכרנות עם המודל)
 */
const BLOCK_REASONS = ["vacation", "maintenance", "training", "other"];

/**
 * סכמת עדכון (PATCH) – לא חייבים לשלוח הכל
 */
const updateBlockSchema = Joi.object({
    resource: Joi.string().hex().length(24).allow(null),
    start: Joi.date().iso(),
    end: Joi.date().iso().greater(Joi.ref("start")),
    timezone: Joi.string(),
    reason: Joi.string().valid(...BLOCK_REASONS),
    notes: Joi.string().max(1000).allow("", null),
    active: Joi.boolean(),
}).min(1);

/* ======================================================
   🟢 HEALTH CHECK
====================================================== */
router.get("/", async (req, res) => {
    res.json({ msg: "Blocks works" });
});

/* ======================================================
   📅 GET BLOCKS BY DAY (למסך קביעת תור)
   GET /blocks/by-day?date=YYYY-MM-DD&worker=xxxxx

   מחזיר:
   - בלוקים של כל העסק (resource = null)
   - ואם נשלח worker תקין – גם בלוקים של אותו worker
   - רק active=true
   - רק בלוקים שחופפים ליום המבוקש
====================================================== */
router.get("/by-day", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        if (!business) {
            return res
                .status(400)
                .json({ msg: "No business in token – cannot load blocks" });
        }

        const { date, worker } = req.query;

        if (!date) {
            return res
                .status(400)
                .json({ msg: "Missing required query param: date (YYYY-MM-DD)" });
        }

        const dayStart = new Date(date);
        if (Number.isNaN(dayStart.getTime())) {
            return res
                .status(400)
                .json({ msg: "Invalid date format, expected YYYY-MM-DD" });
        }

        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1); // סוף היום

        const filter = {
            business,
            active: true,
            // כל בלוק שחופף ליום:
            // start < dayEnd && end > dayStart
            start: { $lt: dayEnd },
            end: { $gt: dayStart },
        };

        if (worker && mongoose.Types.ObjectId.isValid(worker)) {
            // גם בלוקים לכל העסק וגם לאיש צוות ספציפי
            filter.$or = [{ resource: null }, { resource: worker }];
        } else {
            // אם לא עבר worker – נחזיר רק חסימות כלליות של העסק
            filter.resource = null;
        }

        const blocks = await BlockModel.find(filter).sort({ start: 1 });
        res.json(blocks);
    } catch (err) {
        console.error("GET /blocks/by-day error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   📜 GET BLOCKS LIST (לניהול בצד אדמין)
   GET /blocks/list?resource=...&from=2025-01-01&to=2025-01-31&includeInactive=true
====================================================== */
router.get("/list", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        if (!business) {
            return res
                .status(400)
                .json({ msg: "No business in token – cannot load blocks" });
        }

        const { resource, from, to, includeInactive } = req.query;

        const filter = { business };

        // סינון לפי משאב (עובד)
        if (resource) {
            if (resource === "null") {
                // רק בלוקים של "כל העסק"
                filter.resource = null;
            } else if (mongoose.Types.ObjectId.isValid(resource)) {
                filter.resource = resource;
            }
        }

        // ברירת מחדל – להחזיר רק active
        if (!includeInactive || includeInactive === "false") {
            filter.active = true;
        }

        // טווח תאריכים (אופציונלי) לפי start
        if (from || to) {
            filter.start = {};
            if (from) {
                filter.start.$gte = new Date(from);
            }
            if (to) {
                // נוסיף יום קדימה שלא נפספס את סוף היום
                const endDate = new Date(to);
                endDate.setDate(endDate.getDate() + 1);
                filter.start.$lt = endDate;
            }
        }

        const blocks = await BlockModel.find(filter).sort({ start: 1 });
        res.json(blocks);
    } catch (err) {
        console.error("GET /blocks/list error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   ➕ CREATE BLOCK
   POST /blocks
   body: { resource?, start, end, timezone?, reason?, notes? }
   business ו-createdBy נלקחים מה-token
====================================================== */
router.post("/", authAdmin, async (req, res) => {
    try {
        const { business, _id: userId } = req.tokenData;

        if (!business) {
            return res
                .status(400)
                .json({ msg: "No business in token – cannot create block" });
        }

        // נדרוס business + createdBy מה-token, שלא יוכלו לזייף
        const payload = {
            ...req.body,
            business,
            createdBy: userId,
        };

        const valid = validateBlock(payload);
        if (valid.error) {
            return res
                .status(400)
                .json({ msg: "Invalid block data", details: valid.error.details });
        }

        const block = new BlockModel(valid.value);
        await block.save();

        res.status(201).json(block);
    } catch (err) {
        console.error("POST /blocks error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   ✏️ UPDATE BLOCK
   PATCH /blocks/:id
====================================================== */
router.patch("/:id", authAdmin, async (req, res) => {
    try {
        const blockId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(blockId)) {
            return res.status(400).json({ msg: "Invalid block id" });
        }

        const { error, value } = updateBlockSchema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true,
        });

        if (error) {
            return res
                .status(400)
                .json({ msg: "Invalid block update data", details: error.details });
        }

        const updated = await BlockModel.findOneAndUpdate(
            { _id: blockId, business },
            value,
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ msg: "Block not found" });
        }

        res.json(updated);
    } catch (err) {
        console.error("PATCH /blocks/:id error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   🗑 DELETE BLOCK (Soft delete – active=false)
   DELETE /blocks/:id
====================================================== */
router.delete("/:id", authAdmin, async (req, res) => {
    try {
        const blockId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(blockId)) {
            return res.status(400).json({ msg: "Invalid block id" });
        }

        const updated = await BlockModel.findOneAndUpdate(
            { _id: blockId, business },
            { active: false },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ msg: "Block not found" });
        }

        res.json({ msg: "Block deleted", block: updated });
    } catch (err) {
        console.error("DELETE /blocks/:id error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

module.exports = router;
