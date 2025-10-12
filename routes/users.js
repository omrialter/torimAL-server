const express = require("express");
const { UserModel, validateUser, createToken } = require("../models/userModel")
const { auth, authAdmin } = require("../auth/auth.js");
const router = express.Router();
const admin = require('../services/firebase.js');



// only check the token 
router.get("/checkToken", auth, async (req, res) => {
    res.json({ _id: req.tokenData._id, role: req.tokenData.role });
})


router.get("/userInfo", auth, async (req, res) => {
    try {
        let user = await UserModel.findOne({ _id: req.tokenData._id }, { password: 0 })
            .exec()
        res.json(user)
    }
    catch (err) {
        console.log(err);
        res.status(502).json({ err })
    }
})

// Create a new user
// Domain/users
// Add this to your users route file (after importing createToken and UserModel)
router.post('/signup', async (req, res) => {
    const { idToken, name, businessId } = req.body;

    if (!idToken || !name || !businessId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const phone = decodedToken.phone_number;

        if (!phone) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        // Check if user already exists
        let existingUser = await UserModel.findOne({ phone, business: businessId });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create new user
        const newUser = new UserModel({
            name,
            phone,
            business: businessId,
            role: 'user',
        });

        await newUser.save();

        const token = createToken(newUser._id, newUser.role, businessId);

        res.json({ token, user: newUser });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
});




router.post('/check-phone', async (req, res) => {
    const { phone, businessId } = req.body;

    if (!phone || !businessId) {
        return res.status(400).json({ error: 'Phone and businessId are required' });
    }

    try {
        const user = await UserModel.findOne({ phone, business: businessId });


        if (!user) {
            return res.status(404).json({ error: 'User not found or not verified' });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/verify', async (req, res) => {
    const { idToken } = req.body;

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const phone = decodedToken.phone_number;

        if (!phone) return res.status(400).json({ error: 'Invalid phone number' });

        let user = await UserModel.findOne({ phone });
        if (!user) {
            user = new UserModel({ phone, role: 'user' }); // default role
            await user.save();
        }

        const customJwt = createToken(user._id, user.role, user.business);


        res.json({ token: customJwt, user });
    } catch (err) {
        console.error(err);
        res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
});

module.exports = router;