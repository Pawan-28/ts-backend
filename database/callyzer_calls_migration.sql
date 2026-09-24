-- Callyzer call sync: optional external id + nullable lead for unmatched client numbers
ALTER TABLE employee_calls
  MODIFY lead_id INT NULL;

ALTER TABLE employee_calls
  ADD COLUMN callyzer_call_id VARCHAR(100) NULL AFTER employee_id;

CREATE UNIQUE INDEX uq_employee_calls_callyzer
  ON employee_calls (tenant_id, callyzer_call_id);
