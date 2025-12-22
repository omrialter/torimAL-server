// models/userModel.js
const mongoose = require("mongoose");
const Joi = require("joi");
const jwt = require("jsonwebtoken");

// ברירות מחדל להתראות אדמין
const ADMIN_PUSH_DEFAULTS = {
    enabled: true,
    onAppointmentCreated: true,
    onAppointmentCanceled: true,
    onUserSignup: true,
};

// סכמה פנימית (בלי _id)
const adminPushSettingsSchema = new mongoose.Schema(
    {
        enabled: { type: Boolean, default: true },
        onAppointmentCreated: { type: Boolean, default: true },
        onAppointmentCanceled: { type: Boolean, default: true },
        onUserSignup: { type: Boolean, default: true },
    },
    { _id: false }
);

const userSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, required: true },
        phone: { type: String, trim: true, required: true },
        business: { type: mongoose.Schema.Types.ObjectId, ref: "business", required: true },

        // user / admin / worker וכו'
        role: { type: String, default: "user" },

        // Expo push token
        expoPushToken: { type: String, default: null },

        /**
         * ✅ הגדרות Push לאדמינים (פר-אדמין)
         * חשוב: לא לשים default ברמת השדה, כדי שלא יווצר לכל יוזר חדש.
         * ניצור רק כש-role הוא admin.
         */
        adminPushSettings: {
            type: adminPushSettingsSchema,
            default: undefined, // 👈 מונע יצירה אוטומטית לכל משתמש
        },
    },
    { timestamps: true }
);

// אינדקס למנוע כפילויות באותו עסק
userSchema.index({ phone: 1, business: 1 }, { unique: true });

/**
 * create/save: אם זה אדמין ואין עדיין adminPushSettings, ניצור ברירות מחדל
 */
userSchema.pre("save", function (next) {
    if (this.role === "admin" && !this.adminPushSettings) {
        this.adminPushSettings = { ...ADMIN_PUSH_DEFAULTS };
    }

    // אם זה לא admin — נשאיר undefined (לא יהיה שדה במסמך)
    if (this.role !== "admin") {
        this.adminPushSettings = undefined;
    }

    next();
});

/**
 * updateOne/findOneAndUpdate/updateMany:
 * אם משנים role ל-admin ולא נשלח adminPushSettings במפורש — נייצר ברירת מחדל.
 */
userSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
    const update = this.getUpdate() || {};

    const $set = update.$set || {};
    const nextRole = $set.role ?? update.role;

    if (nextRole === "admin") {
        const adminSettingsProvided =
            Object.prototype.hasOwnProperty.call($set, "adminPushSettings") ||
            Object.prototype.hasOwnProperty.call(update, "adminPushSettings") ||
            Object.keys($set).some((k) => k.startsWith("adminPushSettings."));

        if (!adminSettingsProvided) {
            update.$set = {
                ...$set,
                adminPushSettings: { ...ADMIN_PUSH_DEFAULTS },
            };
            this.setUpdate(update);
        }
    }

    // אם מעדכנים role ל-user/worker ורוצים לוודא שהשדה יוסר:
    // לא נוגעים אוטומטית כאן כדי לא להפתיע ב-updates כלליים,
    // אבל אם תרצה אפשר להוסיף ל-route שמחליף role גם $unset.
    next();
});

const UserModel = mongoose.model("users", userSchema);

function createToken(_id, role, business) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET");

    return jwt.sign(
        { _id: String(_id), role, business: String(business) },
        secret,
        { expiresIn: "365d" }
    );
}

function validateUser(payload) {
    const schema = Joi.object({
        name: Joi.string().min(1).max(200).required(),
        phone: Joi.string().min(5).max(30).required(),
        business: Joi.string().required(),
        role: Joi.string().valid("user", "admin", "worker").optional(),
    });

    return schema.validate(payload);
}

module.exports = {
    UserModel,
    createToken,
    validateUser,
};
