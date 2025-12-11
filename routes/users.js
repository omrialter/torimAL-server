const express = require("express");
const { UserModel, createToken } = require("../models/userModel");
const router = express.Router();
const admin = require('../services/firebase.js');
const { auth, authAdmin } = require("../auth/auth.js");
const { toE164IL } = require('../services/utils_phone.js');  // ודא שהנתיב נכון!
const { sendPushToToken } = require("../services/pushService");


// -------------------------
// CHECK TOKEN
// -------------------------
router.get("/checkToken", auth, async (req, res) => {
    res.json({ _id: req.tokenData._id, role: req.tokenData.role });
});


// -------------------------
// USER INFO
// -------------------------
router.get("/userInfo", auth, async (req, res) => {
    try {
        const user = await UserModel.findById(req.tokenData._id).lean();
        res.json(user);
    } catch (err) {
        console.log(err);
        res.status(502).json({ err });
    }
});


// -------------------------
// SIGNUP (phone comes ONLY from Firebase)
// -------------------------
router.post('/signup', async (req, res) => {
    const { idToken, name, businessId } = req.body;

    if (!idToken || !name || !businessId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: 'Invalid phone number' });

        phone = toE164IL(phone);   // ✅ ALWAYS NORMALIZE

        const existing = await UserModel.findOne({ phone, business: businessId });
        if (existing) return res.status(400).json({ error: 'User already exists' });

        const newUser = await UserModel.create({
            name,
            phone,
            business: businessId,
            role: 'user'
        });

        const token = createToken(newUser._id, newUser.role, businessId);
        return res.json({ token, user: newUser });

    } catch (err) {
        console.error('Signup error:', err);
        return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
});


// -------------------------
// CHECK-PHONE
// -------------------------
router.post('/check-phone', async (req, res) => {
    let { phone, businessId } = req.body;

    if (!phone || !businessId) {
        return res.status(400).json({ error: 'Phone and businessId are required' });
    }

    phone = toE164IL(phone);

    try {
        const user = await UserModel.findOne({ phone, business: businessId });
        if (!user) return res.status(404).json({ error: 'User not found or not verified' });

        return res.json({ ok: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error' });
    }
});


// -------------------------
// VERIFY (LOGIN)
// -------------------------
router.post('/verify', async (req, res) => {
    try {
        const { idToken, businessId } = req.body;

        if (!idToken || !businessId) {
            return res.status(400).json({ error: 'Missing idToken or businessId' });
        }

        const decoded = await admin.auth().verifyIdToken(idToken);
        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: 'Invalid phone number' });

        phone = toE164IL(phone);   // ✅ SAME NORMALIZATION AS SIGNUP

        const user = await UserModel.findOne({ phone, business: businessId }).lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found for this business' });
        }

        const token = createToken(user._id, user.role, String(businessId));
        return res.json({ token, user });

    } catch (err) {
        console.error('Verify error:', err);
        return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
});

/**
 * POST /users/me/push-token
 * שומר את Expo Push Token של המשתמש המחובר
 */
router.post("/me/push-token", auth, async (req, res) => {
    try {
        const { expoPushToken } = req.body;

        if (!expoPushToken) {
            return res.status(400).json({ error: "expoPushToken is required" });
        }

        await UserModel.updateOne(
            { _id: req.tokenData._id },
            { $set: { expoPushToken } }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error("Error updating push token:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/me/test-push
 * שולח למשתמש המחובר התראת בדיקה
 */
router.post("/me/test-push", auth, async (req, res) => {
    try {
        const user = await UserModel.findById(req.tokenData._id);

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (!user.expoPushToken) {
            return res
                .status(400)
                .json({ error: "User has no expoPushToken saved" });
        }

        await sendPushToToken(
            user.expoPushToken,
            "בדיקת פוש",
            "אם אתה רואה את זה – המערכת עובדת ✅",
            { type: "test" }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error("test-push error:", err);
        res.status(500).json({ error: "Server error" });
    }
});



module.exports = router;
