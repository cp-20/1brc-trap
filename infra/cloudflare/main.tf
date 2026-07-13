terraform {
  required_version = ">= 1.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21.1"
    }
  }
}

provider "cloudflare" {}

resource "cloudflare_r2_bucket" "datasets" {
  account_id    = var.cloudflare_account_id
  name          = var.bucket_name
  location      = var.location
  storage_class = "Standard"
}
