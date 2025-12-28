const path = require("path");
const http = require("http");

// Load environment variables immediately (MUST be before importing routes/services)
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { connectToMongo } = require("./db/mongoConnect");
const { routesInit } = require("./routes/configRoutes");

// Initialize Express
const app = express();

// Middleware Configuration
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Create HTTP Server
const server = http.createServer(app);
const port = process.env.PORT || 3005;

/**
 * Start Server Logic
 * Connects to MongoDB first, then starts the server.
 * This prevents the server from accepting requests before the DB is ready.
 */
const startServer = async () => {
    try {
        await connectToMongo();
        console.log("MongoDB connected successfully");

        // Initialize Routes (after env is loaded, and after DB is ready)
        routesInit(app);

        server.listen(port, () => {
            console.log(`Server is running and listening on port ${port}`);
        });
    } catch (err) {
        console.error("Failed to connect to MongoDB. Server not started.", err.message);
        process.exit(1);
    }
};

startServer();
