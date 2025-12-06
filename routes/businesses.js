const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const { BusinessModel, validateBusiness } = require("../models/businessModel.js");
const { auth, authAdmin } = require("../auth/auth.js");

const router = express.Router();

/**
 * 🎨 COLOR_PRESETS
 * כל preset מייצג קומבינציית צבעים מוכנה מראש.
 * תוכל להוסיף/לשנות אותם לפי הצורך.
 */
const COLOR_PRESETS = {
    professional: {
        primary: "#1d4ed8",
        secondary: "#f3f4f6",
        third: "#0b1120"
    },
    midnight: {
        primary: "#0ea5e9",
        secondary: "#0f172a",
        third: "#f8fafc"
    },
    forest: {
        primary: "#065f46",
        secondary: "#e6f4f1",
        third: "#0b2722"
    },
    sunset: {
        primary: "#ea580c",
        secondary: "#fff7ed",
        third: "#7c2d12"
    },
    royal: {
        primary: "#7c3aed",
        secondary: "#f3e8ff",
        third: "#2e1065"
    }
};


/**
 * Joi validation לבחירת preset
 */
const colorsPresetSchema = Joi.object({
    preset: Joi.string()
        .valid(...Object.keys(COLOR_PRESETS))
        .required()
});

// Simple health-check
router.get("/", async (req, res) => {
    res.json({ msg: "Businesses works" });
});

// GET /businesses/businessInfo/:id
// מחזיר מידע על העסק *רק אם* הוא העסק של המשתמש מהטוקן
router.get("/businessInfo/:id", auth, async (req, res) => {
    const raw = req.params.id ?? "";
    const id = raw.trim();

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid business id" });
    }

    const { business } = req.tokenData;

    // מוודא שהמשתמש ניגש רק לעסק שלו
    if (business && business !== id) {
        return res.status(403).json({ error: "Access denied – wrong business" });
    }

    try {
        const businessDoc = await BusinessModel.findById(id)
            .populate("owner", "_id name phone avatarUrl")
            .populate("workers", "_id name phone avatarUrl")
            .lean()
            .exec();

        if (!businessDoc) {
            return res.status(404).json({ error: "Business not found" });
        }
        res.json(businessDoc);
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: "Server error" });
    }
});

// POST /businesses
// יצירת עסק חדש – כרגע רק ע"י אדמין (role: "admin")
router.post("/", authAdmin, async (req, res) => {
    const validBody = validateBusiness(req.body);
    if (validBody.error) {
        return res.status(400).json(validBody.error.details);
    }

    try {
        const business = new BusinessModel(req.body);
        await business.save();
        res.json(business);
    } catch (err) {
        console.log(err);
        if (err.code === 11000) {
            res.status(400).json({
                msg: "business with that email already exists",
                code: 11000
            });
        } else {
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
});

// PATCH /businesses/:id/set-owner
// שינוי בעלים לעסק – רק אדמין של אותו עסק
router.patch("/:id/set-owner", authAdmin, async (req, res) => {
    try {
        const rawId = req.params.id ?? "";
        const businessId = rawId.trim();
        const { ownerId } = req.body;
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId)) {
            return res.status(400).json({ msg: "Invalid business id" });
        }

        if (!mongoose.Types.ObjectId.isValid(ownerId)) {
            return res.status(400).json({ msg: "Invalid owner id" });
        }

        // אדמין יכול לשנות בעלות רק על העסק שלו
        if (business && business !== businessId) {
            return res.status(403).json({ msg: "You cannot modify another business" });
        }

        const updated = await BusinessModel.findOneAndUpdate(
            { _id: businessId },
            { owner: ownerId },
            { new: true }
        )
            .populate("owner", "_id name phone avatarUrl")
            .populate("workers", "_id name phone avatarUrl")
            .lean()
            .exec();

        if (!updated) {
            return res.status(404).json({ msg: "Business not found" });
        }

        res.json(updated);
    } catch (err) {
        console.log(err);
        res.status(500).json({ msg: "Failed to update owner", error: err.message });
    }
});

/**
 * PATCH /businesses/colors
 * עדכון צבעי העסק לפי preset קבוע מראש.
 * גישה: authAdmin בלבד (לא יוזר רגיל).
 * שים לב: הנתיב הסופי יהיה /businesses/colors (בהנחה שאתה עושה app.use("/businesses", router))
 */
router.patch("/colors", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData; // מזהה העסק מתוך ה־JWT
        const { error, value } = colorsPresetSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                msg: "Invalid preset value",
                details: error.details
            });
        }

        const { preset } = value;
        const colors = COLOR_PRESETS[preset];

        const updatedBusiness = await BusinessModel.findByIdAndUpdate(
            business,
            { business_colors: colors },
            { new: true }
        );

        if (!updatedBusiness) {
            return res.status(404).json({ msg: "Business not found" });
        }

        res.json({
            msg: "Business colors updated successfully",
            business: updatedBusiness
        });
    } catch (err) {
        console.error("Error updating business colors:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

module.exports = router;
