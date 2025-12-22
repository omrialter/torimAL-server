const express = require("express");
const mongoose = require("mongoose"); // 👈 הוספתי לצורך בדיקת ObjectId
const { UserModel, createToken } = require("../models/userModel");
const router = express.Router();
const admin = require("../services/firebase.js");
const { auth, authAdmin } = require("../auth/auth.js");
const { toE164IL } = require("../services/utils_phone.js");
const { sendPushToToken, sendPushToManyTokens } = require("../services/pushService");

// -------------------------
// Helper: Validate ObjectId
// -------------------------
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// -------------------------
// Admin Push Notify Helper
// -------------------------
async function notifyAdmins(businessId, eventType, title, body, data = {}) {
    try {
        const settingKeyByEvent = {
            appointment_created: "onAppointmentCreated",
            appointment_canceled: "onAppointmentCanceled",
            user_signup: "onUserSignup",
        };

        const key = settingKeyByEvent[eventType];
        if (!key) return { ok: false, error: "Unknown eventType" };

        const admins = await UserModel.find({
            business: businessId,
            role: "admin",
            expoPushToken: { $exists: true, $ne: null },
            "adminPushSettings.enabled": { $ne: false },
        }).select("expoPushToken adminPushSettings");

        const tokens = Array.from(
            new Set(
                admins
                    .filter((a) => a.adminPushSettings?.[key] !== false)
                    .map((a) => a.expoPushToken)
                    .filter((t) => typeof t === "string" && t.trim().length > 0)
                    .map((t) => t.trim())
            )
        );

        if (tokens.length === 0) return { ok: true, sent: 0 };

        return await sendPushToManyTokens(tokens, title, body, {
            ...data,
            type: "admin_event",
            eventType,
            businessId: String(businessId),
            createdAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error("notifyAdmins error:", err);
        return { ok: false };
    }
}

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
        // 🛡️ Security: הוספתי סינון לפי business כדי להבטיח שהמשתמש שייך לעסק שבטוקן
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business
        }).lean();

        if (!user) return res.sendStatus(401); // User might be deleted

        res.json(user);
    } catch (err) {
        console.error("userInfo error:", err);
        // 🛡️ Security: לא מחזירים את err לקלינט
        res.status(502).json({ error: "Server error" });
    }
});

// -------------------------
// SIGNUP (phone comes ONLY from Firebase)
// -------------------------
router.post("/signup", async (req, res) => {
    const { idToken, name, businessId } = req.body;

    if (!idToken || !name || !businessId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // 🛡️ Validation: בדיקה שזה מזהה תקין
    if (!isValidId(businessId)) {
        return res.status(400).json({ error: "Invalid business ID format" });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: "Invalid phone number in token" });

        phone = toE164IL(phone);

        const existing = await UserModel.findOne({ phone, business: businessId });
        if (existing) return res.status(400).json({ error: "User already exists" });

        const newUser = await UserModel.create({
            name,
            phone,
            business: businessId,
            role: "user",
        });

        // ✅ Push Notify (Fire & Forget)
        notifyAdmins(
            businessId,
            "user_signup",
            "נרשם משתמש חדש",
            `${name} נרשם למערכת`,
            { userId: String(newUser._id) }
        ).catch(err => console.error("Signup push failed:", err));

        const token = createToken(newUser._id, newUser.role, businessId);
        return res.json({ token, user: newUser });
    } catch (err) {
        console.error("Signup error:", err);
        // 🛡️ Security: הסתרת פרטים טכניים אם זו שגיאת שרת
        if (err.code && err.code.startsWith('auth/')) {
            return res.status(401).json({ error: "Invalid Firebase ID token" });
        }
        return res.status(500).json({ error: "Server error during signup" });
    }
});

// -------------------------
// CHECK-PHONE
// -------------------------
router.post("/check-phone", async (req, res) => {
    let { phone, businessId } = req.body;

    if (!phone || !businessId) {
        return res.status(400).json({ error: "Phone and businessId are required" });
    }

    if (!isValidId(businessId)) {
        return res.status(400).json({ error: "Invalid business ID format" });
    }

    phone = toE164IL(phone);

    try {
        const user = await UserModel.findOne({ phone, business: businessId }).select("_id"); // Select only ID for performance
        if (!user) return res.status(404).json({ error: "User not found or not verified" });

        return res.json({ ok: true });
    } catch (err) {
        console.error("check-phone error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

// -------------------------
// VERIFY (LOGIN)
// -------------------------
router.post("/verify", async (req, res) => {
    try {
        const { idToken, businessId } = req.body;

        if (!idToken || !businessId) {
            return res.status(400).json({ error: "Missing idToken or businessId" });
        }

        if (!isValidId(businessId)) {
            return res.status(400).json({ error: "Invalid business ID format" });
        }

        // 1) אימות Firebase
        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            console.error("verifyIdToken failed:", e.message);
            return res.status(401).json({ error: "Invalid Firebase ID token" });
        }

        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: "Invalid phone number" });

        phone = toE164IL(phone);

        const user = await UserModel.findOne({ phone, business: businessId }).lean();
        if (!user) {
            return res.status(404).json({ error: "User not found for this business" });
        }

        // 3) יצירת JWT שלנו
        const token = createToken(user._id, user.role, String(businessId));
        return res.json({ token, user });

    } catch (err) {
        console.error("Verify server error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/me/push-token
 * שומר את Expo Push Token של המשתמש המחובר
 */
router.post("/me/push-token", auth, async (req, res) => {
    try {
        const { expoPushToken } = req.body;

        if (!expoPushToken || typeof expoPushToken !== "string") {
            return res.status(400).json({ error: "expoPushToken is required" });
        }

        // 🛡️ Security: מוודאים שהעדכון קורה רק לעסק הנוכחי
        await UserModel.updateOne(
            { _id: req.tokenData._id, business: req.tokenData.business },
            { $set: { expoPushToken: expoPushToken.trim() } }
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
        // 🛡️ Security: וידוא עסק
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (!user.expoPushToken) {
            return res.status(400).json({ error: "User has no expoPushToken saved" });
        }

        const result = await sendPushToToken(
            user.expoPushToken,
            "בדיקת פוש",
            "אם אתה רואה את זה – המערכת עובדת ✅",
            { type: "test" }
        );

        if (result && result.ok === false) {
            return res.status(400).json({ error: "Push send failed", details: result.error });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error("test-push error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/admin/push
 * אדמין שולח פוש לכל המשתמשים בעסק שלו
 */
router.post("/admin/push", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData; // כבר מאומת ב-authAdmin שיש business
        const { title, body, data } = req.body;

        if (!title || !body) {
            return res.status(400).json({ error: "title and body are required" });
        }

        const safeTitle = String(title).trim().slice(0, 80);
        const safeBody = String(body).trim().slice(0, 180);

        if (!safeTitle || !safeBody) {
            return res.status(400).json({ error: "title/body cannot be empty" });
        }

        const users = await UserModel.find({
            business,
            expoPushToken: { $exists: true, $ne: null },
        }).select("expoPushToken");

        const tokens = Array.from(
            new Set(
                users
                    .map((u) => u.expoPushToken)
                    .filter((t) => typeof t === "string" && t.trim().length > 0)
                    .map((t) => t.trim())
            )
        );

        if (tokens.length === 0) {
            return res.status(400).json({ error: "No users with expoPushToken in this business" });
        }

        const payloadData = {
            ...(typeof data === "object" && data ? data : {}),
            type: "admin_broadcast",
            businessId: String(business),
            createdAt: new Date().toISOString(),
        };

        const result = await sendPushToManyTokens(tokens, safeTitle, safeBody, payloadData);

        // ניקוי טוקנים לא חוקיים
        if (result?.invalidTokens?.length) {
            await UserModel.updateMany(
                { business, expoPushToken: { $in: result.invalidTokens } },
                { $set: { expoPushToken: null } }
            );
        }

        res.json({
            ok: true,
            business,
            requestedTokens: tokens.length,
            ...result,
        });
    } catch (err) {
        console.error("admin push error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * GET /users/admin/push-settings
 * מחזיר את ההגדרות של האדמין המחובר
 */
router.get("/admin/push-settings", authAdmin, async (req, res) => {
    try {
        // 🛡️ Security: וידוא business ו-role
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business
        })
            .select("adminPushSettings")
            .lean();

        if (!user) return res.status(404).json({ error: "User not found" });

        res.json({ adminPushSettings: user.adminPushSettings || {} });
    } catch (err) {
        console.error("get admin push-settings error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * PATCH /users/admin/push-settings
 * body: { enabled?, onAppointmentCreated?, onAppointmentCanceled?, onUserSignup? }
 */
router.patch("/admin/push-settings", authAdmin, async (req, res) => {
    try {
        const allowed = ["enabled", "onAppointmentCreated", "onAppointmentCanceled", "onUserSignup"];
        const updates = {};

        for (const key of allowed) {
            if (typeof req.body?.[key] === "boolean") {
                updates[`adminPushSettings.${key}`] = req.body[key];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No valid boolean fields to update" });
        }

        // 🛡️ Security: עדכון עם וידוא קפדני של business
        const updateRes = await UserModel.updateOne(
            {
                _id: req.tokenData._id,
                role: "admin",
                business: req.tokenData.business
            },
            { $set: updates }
        );

        if (updateRes.matchedCount === 0) {
            return res.status(403).json({ error: "Update failed (User not found or not admin)" });
        }

        const user = await UserModel.findOne({ _id: req.tokenData._id, business: req.tokenData.business })
            .select("adminPushSettings")
            .lean();

        res.json({ ok: true, adminPushSettings: user?.adminPushSettings || {} });
    } catch (err) {
        console.error("patch admin push-settings error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;