/**
 * E-05: the employee list used to return everybody's salary, e-mail, phone and targets to any logged-in employee.
 * An employee now sees colleagues' name / role / status / avatar / performance counts - and their OWN row in full.
 */
const PRIVATE_KEYS = new Set([
  "salary", "email", "phone", "employeeId", "callyserId", "callyser_id", "joiningDate", "joining_date",
  "notes", "access_level", "accessLevel", "work_location", "workLocation", "incentive_kra", "incentiveKra",
  "password", "password_hash", "passwordHash", "temp_password", "tempPassword", "emp_id", "empCode",
]);
const PRIVATE_PATTERN = /(_target|Target|_weightage|Weightage)$/;

const isPrivateKey = (key) => PRIVATE_KEYS.has(key) || PRIVATE_PATTERN.test(key);

function redactEmployee(row, viewer) {
  if (!row || typeof row !== "object") return row;
  if (!viewer || viewer.role === "admin") return row;
  const selfId = viewer.employeeId == null ? null : String(viewer.employeeId);
  if (selfId && String(row.id) === selfId) return row; // your own profile is yours
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!isPrivateKey(key)) out[key] = value;
  }
  return out;
}

const redactEmployees = (rows, viewer) => (Array.isArray(rows) ? rows.map((r) => redactEmployee(r, viewer)) : rows);

module.exports = { redactEmployee, redactEmployees, isPrivateKey };
