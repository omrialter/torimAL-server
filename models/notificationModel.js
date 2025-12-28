const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
    {
        business: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "businesses", // Must match the model name exactly
            required: true,
            index: true,
        },

        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80,
        },

        body: {
            type: String,
            required: true,
            trim: true,
            maxlength: 180,
        },

        // Payload for the client app (e.g., navigation params, deep links)
        data: {
            type: Object,
            default: {},
        },

        type: {
            type: String,
            enum: ["admin_broadcast", "system"],
            default: "admin_broadcast",
        },
    },
    { timestamps: true }
);

// Compound Index: Optimized for fetching the latest notifications for a specific business
notificationSchema.index({ business: 1, createdAt: -1 });

const NotificationModel = mongoose.model("notification", notificationSchema);

module.exports = { NotificationModel };