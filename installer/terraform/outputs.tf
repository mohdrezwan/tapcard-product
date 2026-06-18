output "backend_url" {
  description = "Cloud Run service URL"
  value       = module.cloudrun.service_url
}

output "hosting_url" {
  description = "Firebase Hosting default URL"
  value       = "https://${var.project_id}.web.app"
}

output "photo_bucket" {
  description = "GCS bucket for profile photos"
  value       = module.storage.bucket_name
}

output "service_account_email" {
  description = "Cloud Run service account email"
  value       = module.iam.service_account_email
}
