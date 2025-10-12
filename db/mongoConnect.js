const mongoose = require("mongoose");

mongoose.set("strictQuery", false);

exports.connectToMongo = async () => {
    try {
        await mongoose.connect(process.env.URLDB);
    } catch (err) {
        throw new Error("MongoDB connection failed: " + err.message);
    }
};
