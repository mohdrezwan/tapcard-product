terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "iam" {
  source             = "./modules/iam"
  project_id         = var.project_id
  service_account_id = var.service_account_id
  bucket_name        = var.bucket_name
}

module "storage" {
  source      = "./modules/storage"
  project_id  = var.project_id
  bucket_name = var.bucket_name
  region      = var.region
}

module "firestore" {
  source     = "./modules/firestore"
  project_id = var.project_id
  region     = var.region
}

module "cloudrun" {
  source          = "./modules/cloudrun"
  project_id      = var.project_id
  region          = var.region
  service_account = module.iam.service_account_email

  depends_on = [module.iam, module.firestore]
}
