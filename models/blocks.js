// models/blocks.js
const mongoose = require('mongoose');
const Joi = require('joi');

const BLOCK_REASONS = ['vacation', 'maintenance', 'training', 'other'];

const blockSchema = new mongoose.Schema(
    {
        // העסק שעליו החסימה חלה (חובה)
        business: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'businesses',
            required: true,
            index: true
        },

        // משאב ספציפי (אם יש כמה עובדים/עמדות). null = כל העסק.
        resource: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true
        },

        // טווח זמן ב-UTC
        start: { type: Date, required: true, index: true },
        end: { type: Date, required: true },

        // אזור זמן להצגה
        timezone: { type: String, required: true, default: 'Asia/Jerusalem' },

        // סיבה והערות
        reason: { type: String, enum: BLOCK_REASONS, default: 'other' },
        notes: { type: String },

        // מי יצר
        createdBy: { type: mongoose.Schema.Types.ObjectId }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

// אינדקסים לשיפור חיפושים
blockSchema.index({ business: 1, resource: 1, start: 1 });
blockSchema.index({ business: 1, start: 1 });

// ולידציה בסיסית לפני שמירה
blockSchema.pre('save', function (next) {
    if (this.end <= this.start) {
        return next(new Error('Block "end" must be greater than "start"'));
    }
    next();
});

exports.BlockModel = mongoose.models.blocks || mongoose.model('blocks', blockSchema);

// ================== Joi Validation ==================

exports.validateBlock = (_reqBody) => {
    const joiSchema = Joi.object({
        business: Joi.string().hex().length(24).required(),
        resource: Joi.string().hex().length(24).allow(null),
        start: Joi.date().iso().required(),
        end: Joi.date().iso().greater(Joi.ref('start')).required(),
        timezone: Joi.string().default('Asia/Jerusalem'),
        reason: Joi.string().valid(...BLOCK_REASONS).default('other'),
        notes: Joi.string().max(1000).allow('', null),
        createdBy: Joi.string().hex().length(24).optional()
    });

    return joiSchema.validate(_reqBody, { abortEarly: false, stripUnknown: true });
};
