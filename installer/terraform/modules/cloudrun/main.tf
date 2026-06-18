resource "google_cloud_run_v2_service" "tapcard_api" {
  name     = "tapcard-api"
  location = var.region
  project  = var.project_id

  template {
    service_account = var.service_account

    containers {
      image = "mohdrezwan/tapcard-backend:latest"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 10
        period_seconds        = 5
        failure_threshold     = 5
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }
  }

  # Ignore image + env changes — managed by gcloud run deploy in setup.sh / update.sh
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.tapcard_api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
