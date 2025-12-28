const indexR = require("./index");
const usersR = require("./users");
const blocksR = require("./blocks");
const businessesR = require("./businesses");
const appointmentsR = require("./appointments");
const notificationsR = require("./notifications");

/**
 * Initialize all application routes
 * @param {object} app - The Express application instance
 */
exports.routesInit = (app) => {
    // Define Route Paths
    app.use("/", indexR);
    app.use("/users", usersR);
    app.use("/blocks", blocksR);
    app.use("/businesses", businessesR);
    app.use("/appointments", appointmentsR);
    app.use("/notifications", notificationsR);

    // 404 Handler - Catch-all for undefined routes
    app.use("*", (req, res) => {
        res.status(404).json({
            msg: "Endpoint not found",
            error: 404
        });
    });
};