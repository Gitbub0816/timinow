INSERT OR IGNORE INTO tenants (id, clerk_org_id, name, slug) VALUES
  ('tenant_bayview', 'org_demo_bayview', 'Bayview Veterinary Emergency & Urgent Care', 'bayview'),
  ('tenant_hearth', 'org_demo_hearth', 'Hearth & Paw Veterinary', 'hearth-paw'),
  ('tenant_juniper', 'org_demo_juniper', 'Juniper Animal Care', 'juniper');

INSERT OR IGNORE INTO locations (
  id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone,
  latitude, longitude, open_24_hours, accepts_walk_ins, auto_accept, arrival_window_minutes,
  species_json, capabilities_json, hours_json, base_exam_fee_cents
) VALUES
  ('loc_bayview', 'tenant_bayview', 'Bayview Veterinary Emergency', 'bayview-emergency', 'emergency', '2211 Shoreline Drive', 'Hayward', 'CA', '94545', '(510) 555-0138', 37.6536, -122.1197, 1, 1, 0, 20, '["dog","cat","bird","rabbit"]', '["emergency","urgent","surgery","oxygen","toxin","imaging","overnight"]', '{"always":"open"}', 18500),
  ('loc_hearth', 'tenant_hearth', 'Hearth & Paw Urgent Care', 'hearth-paw-urgent', 'urgent', '1555 B Street', 'Hayward', 'CA', '94541', '(510) 555-0194', 37.6718, -122.0824, 0, 1, 1, 25, '["dog","cat"]', '["urgent","minor_injury","vomiting","same_day","imaging"]', '{"thu":{"open":"08:00","close":"22:00"}}', 8900),
  ('loc_juniper', 'tenant_juniper', 'Juniper Animal Care', 'juniper-animal-care', 'general', '3100 Castro Valley Boulevard', 'Castro Valley', 'CA', '94546', '(510) 555-0161', 37.6944, -122.0868, 0, 1, 0, 30, '["dog","cat"]', '["same_day","wellness","minor_injury","vaccines"]', '{"thu":{"open":"08:00","close":"18:00"}}', 7200);

INSERT OR IGNORE INTO tenant_policies (
  id, tenant_id, version, deposit_required, deposit_amount_cents, deposit_refundable,
  free_cancel_minutes, completed_platform_fee_cents, no_show_platform_fee_cents,
  late_cancel_platform_fee_cents, policy_json
) VALUES
  ('policy_bayview_v1', 'tenant_bayview', 1, 1, 7500, 1, 15, 2000, 500, 500, '{"label":"Emergency intake deposit","nonRefundableAfterArrival":true}'),
  ('policy_hearth_v1', 'tenant_hearth', 1, 1, 5000, 1, 30, 2000, 500, 500, '{"label":"Urgent-care arrival hold"}'),
  ('policy_juniper_v1', 'tenant_juniper', 1, 0, 0, 1, 0, 2000, 500, 500, '{"label":"No deposit required"}');

INSERT OR IGNORE INTO availability_reports (
  id, location_id, intake_status, stable_wait_min, stable_wait_max, capacity_count,
  accepts_critical, source, confidence, note, reported_at, expires_at, created_by
) VALUES
  ('availability_bayview_seed', 'loc_bayview', 'limited', 75, 135, 2, 1, 'hospital', 'high', 'Critical patients are always triaged on arrival.', datetime('now'), datetime('now', '+30 minutes'), 'demo-clinic'),
  ('availability_hearth_seed', 'loc_hearth', 'available', 15, 35, 3, 0, 'hospital', 'high', 'Accepting stable urgent-care arrivals.', datetime('now'), datetime('now', '+30 minutes'), 'demo-clinic'),
  ('availability_juniper_seed', 'loc_juniper', 'confirm_first', 30, 60, 1, 0, 'timi_request', 'medium', 'Call-ahead confirmation required.', datetime('now'), datetime('now', '+30 minutes'), 'demo-clinic');
