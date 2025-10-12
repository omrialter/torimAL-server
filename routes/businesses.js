const express = require("express");
const { BusinessModel, validateBusiness } = require("../models/businessModel.js")
const { auth, authAdmin } = require("../auth/auth.js");
const router = express.Router();
const mongoose = require("mongoose");

router.get("/", async (req, res) => {
    res.json({ msg: "Businesses works" });
})



router.get("/businessInfo/:id", auth, async (req, res) => {
    const raw = req.params.id ?? "";
    const id = raw.trim(); // <— strip \n, spaces, etc.

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid business id" });
    }

    try {
        const business = await BusinessModel.findById(id).lean().exec();
        if (!business) return res.status(404).json({ error: "Business not found" });
        res.json(business);
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: "Server error" });
    }
});



// create a business

router.post("/", async (req, res) => {
    let validBody = validateBusiness(req.body);
    if (validBody.error) {
        return res.status(400).json(validBody.error.details)
    }
    try {
        let business = new BusinessModel(req.body);
        await business.save();
        res.json(business);
    }
    catch (err) {
        console.log(err);
        if (err.code == 11000) {
            res.status(400).json({ msg: "business with that email already exists", code: 11000 });
        } else {
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }

})

// add an owner to a business

router.patch("/:id/set-owner", async (req, res) => {
    try {
        const businessId = req.params.id;
        const { ownerId } = req.body;

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { owner: ownerId },
            { new: true } // return the updated document
        );

        res.json(updated);
    } catch (err) {
        console.log(err);
        res.status(500).json({ msg: "Failed to update owner", error: err.message });
    }
});



module.exports = router;