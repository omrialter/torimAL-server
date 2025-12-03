const mongoose = require('mongoose');
const Joi = require("joi");

const defaultOpeningHours = {
    sunday: { open: "09:00", close: "17:00" },
    monday: { open: "09:00", close: "17:00" },
    tuesday: { open: "09:00", close: "17:00" },
    wednesday: { open: "09:00", close: "17:00" },
    thursday: { open: "09:00", close: "17:00" },
    friday: { open: "09:00", close: "13:00" },
    saturday: { open: null, close: null } // סגור
};

const businessSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: String,
    email: String,
    address: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },

    portfolio: {
        type: [String],
        default: () => []
    },
    banner: {
        type: String,
        default: ""
    },
    message: {
        type: String,
        default: ""
    },
    openingHoursTxt: String,
    services: [
        {
            name: String,
            duration: Number, // בדקות
            price: Number
        }
    ],
    openingHours: {
        type: Object,
        default: () => ({ ...defaultOpeningHours })
    },
    createdAt: { type: Date, default: Date.now }
});

exports.BusinessModel = mongoose.model('businesses', businessSchema);


exports.validateBusiness = (_reqBody) => {

    const timeRange = Joi.object({
        open: Joi.string()
            .allow(null)
            .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .allow(""),
        close: Joi.string()
            .allow(null)
            .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .allow("")
    });

    const joiSchema = Joi.object({
        name: Joi.string().min(2).max(200).required(),
        phone: Joi.string().min(6).max(20),
        email: Joi.string().max(200).email().required(),
        openingHoursTxt: Joi.string().max(100),
        address: Joi.string().max(300),
        owner: Joi.string().hex().length(24), // ObjectId של בעל העסק
        services: Joi.array().items(Joi.object({
            name: Joi.string().min(1).max(100).required(),
            duration: Joi.number().min(1).max(480).required(),
            price: Joi.number().min(0).required()
        })),
        openingHours: Joi.object({
            sunday: timeRange,
            monday: timeRange,
            tuesday: timeRange,
            wednesday: timeRange,
            thursday: timeRange,
            friday: timeRange,
            saturday: timeRange
        }).optional()
    });

    return joiSchema.validate(_reqBody);
};
