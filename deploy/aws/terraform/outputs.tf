output "https_endpoint" {
  value = "https://${var.dns_name}"
}

output "coordinator_ecr_repository_url" { value = aws_ecr_repository.coordinator.repository_url }
output "worker_ecr_repository_url" { value = aws_ecr_repository.worker.repository_url }
output "coordinator_image" { value = "${aws_ecr_repository.coordinator.repository_url}:${var.release_tag}" }
output "worker_image" { value = "${aws_ecr_repository.worker.repository_url}:${var.release_tag}" }
output "instance_id" { value = aws_instance.coordinator.id }
output "load_balancer_arn" { value = aws_lb.this.arn }
output "target_group_arn" { value = aws_lb_target_group.coordinator.arn }
output "instance_role_arn" { value = aws_iam_role.instance.arn }
output "release_tag" { value = var.release_tag }
