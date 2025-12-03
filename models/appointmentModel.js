// models/appointmentModel.js
const mongoose = require('mongoose');
const Joi = require("joi");

const appointmentSchema = new mongoose.Schema({
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'businesses',
        required: true
    },

    client: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'users',
        required: true
    },

    // 👇 עובד שמבצע את הטיפול
    worker: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'users',
        required: true
    },

    service: {
        name: { type: String, required: true },
        duration: { type: Number, required: true }, // in minutes
        price: { type: Number, required: true }
    },

    start: { type: Date, required: true },

    notes: String,

    status: {
        type: String,
        enum: ['confirmed', 'canceled', 'completed', 'no_show'],
        default: 'confirmed',
        required: true
    },

    createdAt: { type: Date, default: Date.now }
});

// אינדקס ייחודי על עסק+עובד+תחילת תור (רק לסטטוס confirmed)
// ככה עובד אחד לא יכול להיות מוזמן פעמיים לאותה שעה,
// אבל שני עובדים שונים כן יכולים לעבוד במקביל.
appointmentSchema.index(
    { business: 1, worker: 1, start: 1 },
    {
        unique: true,
        partialFilterExpression: {
            status: { $in: ['confirmed'] }
        }
    }
);

exports.AppointmentModel = mongoose.model('appointments', appointmentSchema);

exports.validateAppointment = (_reqBody) => {
    const serviceSchema = Joi.object({
        name: Joi.string().min(1).max(100).required(),
        duration: Joi.number().min(1).max(480).required(),
        price: Joi.number().min(0).max(10000).required()
    });

    const joiSchema = Joi.object({
        client: Joi.string().hex().length(24).required(),
        business: Joi.string().hex().length(24).required(),
        worker: Joi.string().hex().length(24).required(), // 👈 חדש
        service: serviceSchema.required(),
        start: Joi.date().iso().greater('now').required(),
        notes: Joi.string().max(1000).allow("", null),
        status: Joi.string().valid('confirmed', 'canceled', 'completed', 'no_show')
    });

    return joiSchema.validate(_reqBody);
};
