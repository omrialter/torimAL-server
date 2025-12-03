const express = require("express");
const { BusinessModel, validateBusiness } = require("../models/businessModel.js");
const { auth, authAdmin } = require("../auth/auth.js");
const mongoose = require("mongoose");

const router = express.Router();

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
        const businessDoc = await BusinessModel.findById(id).lean().exec();
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
            res.status(400).json({ msg: "business with that email already exists", code: 11000 });
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
        ).exec();

        if (!updated) {
            return res.status(404).json({ msg: "Business not found" });
        }

        res.json(updated);
    } catch (err) {
        console.log(err);
        res.status(500).json({ msg: "Failed to update owner", error: err.message });
    }
});

module.exports = router;
