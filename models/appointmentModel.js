const mongoose = require('mongoose');
const Joi = require("joi");

const appointmentSchema = new mongoose.Schema({
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'businesses', required: true },
    service: {
        name: { type: String, required: true },
        duration: { type: Number, required: true }, // in minutes
        price: { type: Number, required: true }
    },
    start: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'cancelled'], default: 'pending' },
    notes: String,
    createdAt: { type: Date, default: Date.now }
});

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
        service: serviceSchema.required(),
        start: Joi.date().iso().greater('now').required(),
        status: Joi.string().valid("pending", "confirmed", "cancelled").optional(),
        notes: Joi.string().max(1000).allow("", null),
    });

    return joiSchema.validate(_reqBody);
};
