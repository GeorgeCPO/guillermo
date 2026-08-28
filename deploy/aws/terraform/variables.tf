variable "aws_region" {
  description = "AWS region for all Guillermo resources."
  type        = string
}

variable "vpc_id" {
  description = "Existing VPC ID."
  type        = string
}

variable "alb_public_subnet_ids" {
  description = "At least two public subnet IDs in distinct Availability Zones for the ALB."
  type        = list(string)
  validation {
    condition     = length(var.alb_public_subnet_ids) >= 2
    error_message = "Provide at least two ALB public subnet IDs."
  }
}

variable "ec2_subnet_id" {
  description = "Subnet for the EC2 host. It needs outbound internet/NAT access and ALB reachability."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type compatible with instance_architecture."
  type        = string
  default     = "t3.medium"
}

variable "instance_architecture" {
  description = "EC2/image architecture."
  type        = string
  default     = "x86_64"
  validation {
    condition     = contains(["x86_64", "arm64"], var.instance_architecture)
    error_message = "instance_architecture must be x86_64 or arm64."
  }
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN in aws_region for the HTTPS listener."
  type        = string
}

variable "dns_name" {
  description = "Fully qualified public hostname covered by the ACM certificate. An alias is created when route53_hosted_zone_id is also set."
  type        = string
  validation {
    condition     = length(var.dns_name) <= 253 && length(split(".", var.dns_name)) >= 2 && alltrue([for label in split(".", var.dns_name) : can(regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", label))])
    error_message = "dns_name must be a fully qualified DNS hostname without a trailing dot."
  }
}

variable "route53_hosted_zone_id" {
  description = "Optional Route 53 public hosted zone ID used with dns_name."
  type        = string
  default     = ""
}

variable "allowed_https_cidrs" {
  description = "IPv4 CIDRs allowed to reach the ALB HTTPS listener. Keep these synchronized with Atlassian's published outgoing-connection ranges."
  type        = list(string)
  default = [
    "13.200.41.128/25",
    "13.236.8.224/28",
    "16.63.53.128/25",
    "18.136.214.96/28",
    "18.184.99.224/28",
    "18.234.32.224/28",
    "18.246.31.224/28",
    "43.202.69.0/25",
    "52.215.192.224/28",
    "104.192.136.0/21",
    "185.166.140.0/22",
  ]
}

variable "runtime_secret_arn" {
  description = "ARN of the Secrets Manager JSON secret holding runtime values. Values are never read by Terraform."
  type        = string
}

variable "github_private_key_secret_arn" {
  description = "ARN of the Secrets Manager secret whose SecretString is the GitHub App PEM."
  type        = string
}

variable "secret_kms_key_arns" {
  description = "Customer-managed KMS key ARNs needed to decrypt the configured secrets, or an empty list for aws/secretsmanager."
  type        = list(string)
  default     = []
}

variable "ecr_kms_key_arn" {
  description = "Optional customer-managed KMS key ARN for ECR encryption; empty uses AES256."
  type        = string
  default     = ""
}

variable "release_tag" {
  description = "Immutable coordinator/worker release tag, normally a full Git commit SHA. Never use latest."
  type        = string
  validation {
    condition     = var.release_tag != "latest" && can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.release_tag))
    error_message = "release_tag must be an immutable Docker tag and cannot be latest."
  }
}

variable "coordinator_repository_name" {
  type    = string
  default = "guillermo-coordinator"
}

variable "worker_repository_name" {
  type    = string
  default = "guillermo-worker"
}

variable "root_volume_size_gib" {
  type    = number
  default = 40
  validation {
    condition     = var.root_volume_size_gib >= 20
    error_message = "root_volume_size_gib must be at least 20 GiB."
  }
}

variable "tags" {
  type = map(string)
  default = {
    Project   = "guillermo"
    ManagedBy = "terraform"
  }
}
