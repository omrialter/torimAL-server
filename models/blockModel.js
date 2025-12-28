const mongoose = require("mongoose");
const Joi = require("joi");

const BLOCK_REASONS = ["vacation", "maintenance", "training", "other"];

const blockSchema = new mongoose.Schema(
    {
        // The business this block applies to
        business: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "businesses",
            required: true,
            index: true,
        },

        // Specific resource (Worker/Station). If null, applies to the entire business.
        resource: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "users",
            default: null,
            index: true,
        },

        // Time range in UTC
        start: { type: Date, required: true, index: true },
        end: { type: Date, required: true },

        // Display timezone (informative only)
        timezone: { type: String, required: true, default: "Asia/Jerusalem" },

        reason: { type: String, enum: BLOCK_REASONS, default: "other" },
        notes: { type: String },

        // Audit: Who created the block
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "users",
        },

        // Soft Delete: Allows history tracking instead of permanent removal
        active: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    {
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    }
);

// Indexes for common queries
blockSchema.index({ business: 1, resource: 1, start: 1, active: 1 });
blockSchema.index({ business: 1, start: 1, active: 1 });

// Pre-save validation: Ensure end time is after start time
blockSchema.pre("save", function (next) {
    if (this.end <= this.start) {
        return next(new Error('Block "end" must be greater than "start"'));
    }
    next();
});

exports.BlockModel = mongoose.models.blocks || mongoose.model("blocks", blockSchema);

// ================== Joi Validation ==================

exports.validateBlock = (reqBody) => {
    const joiSchema = Joi.object({
        business: Joi.string().hex().length(24).required(),
        resource: Joi.string().hex().length(24).allow(null),
        start: Joi.date().iso().required(),
        end: Joi.date().iso().greater(Joi.ref("start")).required(),
        timezone: Joi.string().default("Asia/Jerusalem"),
        reason: Joi.string().valid(...BLOCK_REASONS).default("other"),
        notes: Joi.string().max(1000).allow("", null),
        createdBy: Joi.string().hex().length(24).optional(),
        active: Joi.boolean().default(true),
    });

    return joiSchema.validate(reqBody, {
        abortEarly: false,
        stripUnknown: true,
    });
};