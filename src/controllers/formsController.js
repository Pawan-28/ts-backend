const dataService = require("../services/dataService");

const listForms = async (req, res) => {
  const result = await dataService.listForms();
  res.json(result);
};

const createForm = async (req, res) => {
  try {
    const result = await dataService.createForm(dataService.TENANT, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateForm = async (req, res) => {
  try {
    const result = await dataService.updateForm(dataService.TENANT, req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

module.exports = { listForms, createForm, updateForm };
