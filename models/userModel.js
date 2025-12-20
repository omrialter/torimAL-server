// models/userModel.js
const mongoose = require("mongoose");
const Joi = require("joi");
const jwt = require("jsonwebtoken");

const userSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, required: true },
        phone: { type: String, trim: true, required: true },
        business: { type: mongoose.Schema.Types.ObjectId, ref: "business", required: true },

        // user / admin / worker וכו'
        role: { type: String, default: "user" },

        // Expo push token (לכל מכשיר יכול להיות token אחר; אצלך זה נשמר פר משתמש)
        expoPushToken: { type: String, default: null },

        // ✅ הגדרות Push לאדמינים (פר-אדמין)
        adminPushSettings: {
            enabled: { type: Boolean, default: true },
            onAppointmentCreated: { type: Boolean, default: true },
            onAppointmentCanceled: { type: Boolean, default: true },
            onUserSignup: { type: Boolean, default: true },
        },
    },
    { timestamps: true }
);

// רצוי (אם אין לך כבר): אינדקס למנוע כפילויות באותו עסק
userSchema.index({ phone: 1, business: 1 }, { unique: true });

const UserModel = mongoose.model("users", userSchema);

// אם כבר יש לך SECRET אצלך ב-env, תשאיר את זה כמו אצלך
function createToken(_id, role, business) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET");

    return jwt.sign(
        { _id: String(_id), role, business: String(business) },
        secret,
        { expiresIn: "365d" }
    );
}

// (אופציונלי) ולידציה בסיסית אם אתה משתמש בזה במקומות אחרים
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
