resource "google_service_account" "tapcard_api" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "TapCard API"
  description  = "Service account for the TapCard Cloud Run service"
}

resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.tapcard_api.email}"
}

resource "google_project_iam_member" "storage_object_admin" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.tapcard_api.email}"
}
