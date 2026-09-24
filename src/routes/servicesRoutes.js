const express = require("express");
const router = express.Router();
const { listServices, createService, deleteService, distributeServiceLeadsNow, updateDistributionConfig } = require("../controllers/servicesController");

router.get("/", listServices);
router.post("/", createService);
router.delete("/:serviceId", deleteService);
router.put("/:serviceId/distribution", updateDistributionConfig);
router.post("/:serviceId/distribute", distributeServiceLeadsNow);

module.exports = router;
