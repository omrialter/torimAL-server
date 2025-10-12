const express = require("express");
const { AppointmentModel } = require("../models/businessModel.js")
const { auth, authAdmin } = require("../auth/auth.js");
const router = express.Router();

router.get("/", async (req, res) => {
    res.json({ msg: "Appointments works" });
})

module.exports = router;