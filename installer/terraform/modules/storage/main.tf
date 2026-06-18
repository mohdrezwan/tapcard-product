resource "google_storage_bucket" "photos" {
  name          = var.bucket_name
  project       = var.project_id
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }
}

resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.photos.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
