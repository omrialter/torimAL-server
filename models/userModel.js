const mongoose = require("mongoose");
const Joi = require("joi");
const jwt = require("jsonwebtoken");

// Default push notification settings for admins
const ADMIN_PUSH_DEFAULTS = {
    enabled: true,
    onAppointmentCreated: true,
    onAppointmentCanceled: true,
    onUserSignup: true,
};

// Sub-schema for admin settings (no _id required)
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
        // Reference to the Business model
        business: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "business",
            required: true,
        },
        // Roles: 'user', 'admin', 'worker'
        role: { type: String, default: "user" },

        // Expo Push Token for mobile notifications
        expoPushToken: { type: String, default: null },
        lastSeenNotificationsAt: { type: Date, default: null },

        /**
         * Admin Push Settings:
         * - Only exists for admins.
         * - Default is undefined to save space for regular users.
         */
        adminPushSettings: {
            type: adminPushSettingsSchema,
            default: undefined,
        },
    },
    { timestamps: true }
);

// Compound Index: Ensures a phone number is unique PER business
// (A user can sign up for multiple businesses with the same phone)
userSchema.index({ phone: 1, business: 1 }, { unique: true });

/**
 * Pre-save Middleware:
 * Automatically handles adminPushSettings creation or removal based on role.
 */
userSchema.pre("save", function (next) {
    // If admin and settings missing -> inject defaults
    if (this.role === "admin" && !this.adminPushSettings) {
        this.adminPushSettings = { ...ADMIN_PUSH_DEFAULTS };
    }

    // If not admin -> ensure settings are undefined (clean up)
    if (this.role !== "admin") {
        this.adminPushSettings = undefined;
    }

    next();
});

/**
 * Pre-update Middleware (updateOne, findOneAndUpdate, etc.):
 * Ensures that if a user is promoted to 'admin', they get default settings
 * if none were provided in the update payload.
 */
userSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
    const update = this.getUpdate() || {};
    const $set = update.$set || {};

    // Check if the role is being updated
    const nextRole = $set.role ?? update.role;

    if (nextRole === "admin") {
        // Check if adminPushSettings are provided in any way
        const adminSettingsProvided =
            Object.prototype.hasOwnProperty.call($set, "adminPushSettings") ||
            Object.prototype.hasOwnProperty.call(update, "adminPushSettings") ||
            Object.keys($set).some((k) => k.startsWith("adminPushSettings."));

        // If role becomes admin but no settings provided -> inject defaults
        if (!adminSettingsProvided) {
            update.$set = {
                ...$set,
                adminPushSettings: { ...ADMIN_PUSH_DEFAULTS },
            };
            this.setUpdate(update);
        }
    }

    next();
});

const UserModel = mongoose.model("users", userSchema);

/**
 * Generate JWT Token
 * @param {string} _id - User ID
 * @param {string} role - User Role
 * @param {string} business - Business ID
 */
function createToken(_id, role, business) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET environment variable");

    return jwt.sign(
        { _id: String(_id), role, business: String(business) },
        secret,
        { expiresIn: "365d" } // Token valid for 1 year
    );
}

/**
 * Validate User Input (Joi)
 */
function validateUser(payload) {
    const schema = Joi.object({
        name: Joi.string().min(1).max(200).required(),
        phone: Joi.string().min(5).max(30).required(),
        business: Joi.string().required(), // Expecting ObjectId string
        role: Joi.string().valid("user", "admin", "worker").optional(),
        expoPushToken: Joi.string().allow(null, "").optional(),
    });

    return schema.validate(payload);
}

module.exports = {
    UserModel,
    createToken,
    validateUser,
};