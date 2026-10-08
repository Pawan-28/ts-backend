/**
 * Who a lead is assigned to, whatever shape the lead object has.
 *
 * A lead read WITHOUT populate carries `assignedTo: {}` (an object with no id) - and `{}` is truthy, so code that only checks
 * "is there an assignee" or reads `.id` silently finds nobody. That is exactly how a customer's booking - sent by n8n as an
 * UPDATE of a lead that already existed - used to be dropped: "meeting in payload but no assigned employee".
 *
 * `loadPopulated()` is only called when the lead object itself has no usable id; it must return the lead read with populate.
 */
const idOf = (v) => {
  if (v && typeof v === "object") return v.id ?? v._id ?? null;
  return v === undefined || v === "" ? null : v;
};

async function resolveAssigneeId(lead, loadPopulated) {
  const direct = idOf(lead?.assignedTo) ?? idOf(lead?.assigned_to);
  if (direct != null) return direct;
  if (typeof loadPopulated !== "function") return null;
  const populated = await loadPopulated();
  return idOf(populated?.assignedTo) ?? idOf(populated?.assigned_to) ?? null;
}

module.exports = { idOf, resolveAssigneeId };
