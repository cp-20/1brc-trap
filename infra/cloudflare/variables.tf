variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the dataset bucket"
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket used for contest datasets"
  type        = string
  default     = "onebrc-datasets"
}

variable "location" {
  description = "R2 location hint"
  type        = string
  default     = "APAC"
}
