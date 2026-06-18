variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run and storage"
  type        = string
  default     = "asia-southeast1"
}

variable "bucket_name" {
  description = "GCS bucket name for profile photos"
  type        = string
}

variable "service_account_id" {
  description = "Service account ID for the Cloud Run service"
  type        = string
  default     = "tapcard-api-sa"
}
