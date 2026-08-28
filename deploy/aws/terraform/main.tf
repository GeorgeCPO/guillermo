data "aws_partition" "current" {}

data "aws_ssm_parameter" "al2023_ami" {
  name = var.instance_architecture == "arm64" ? "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" : "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  secret_arns = [var.runtime_secret_arn, var.github_private_key_secret_arn]
  create_dns  = var.route53_hosted_zone_id != ""
}

resource "aws_cloudwatch_log_group" "coordinator" {
  name              = var.coordinator_log_group_name
  retention_in_days = var.coordinator_log_retention_days
  kms_key_id        = var.cloudwatch_logs_kms_key_arn == "" ? null : var.cloudwatch_logs_kms_key_arn

  # Production logs normally outlive this single EC2 stack. With the default
  # true value, destroy removes the group from state but leaves its retained
  # events in CloudWatch. See RUNBOOK.md before changing this to false.
  skip_destroy = var.coordinator_log_group_skip_destroy

  tags = {
    Name               = "guillermo-coordinator"
    Component          = "coordinator"
    Environment        = "production"
    DataClassification = "operational-metadata"
  }
}

resource "aws_ecr_repository" "coordinator" {
  name                 = var.coordinator_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = var.ecr_kms_key_arn == "" ? "AES256" : "KMS"
    kms_key         = var.ecr_kms_key_arn == "" ? null : var.ecr_kms_key_arn
  }
}

resource "aws_ecr_repository" "worker" {
  name                 = var.worker_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = var.ecr_kms_key_arn == "" ? "AES256" : "KMS"
    kms_key         = var.ecr_kms_key_arn == "" ? null : var.ecr_kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each   = { coordinator = aws_ecr_repository.coordinator.name, worker = aws_ecr_repository.worker.name }
  repository = each.value
  policy = jsonencode({
    rules = [
      { rulePriority = 1, description = "Expire untagged images", selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }, action = { type = "expire" } },
      { rulePriority = 2, description = "Retain the newest 30 releases", selection = { tagStatus = "tagged", tagPatternList = ["*"], countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }
    ]
  })
}

resource "aws_iam_role" "instance" {
  name_prefix = "guillermo-ec2-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "guillermo-runtime"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "EcrAuthentication"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid      = "PullReleaseImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = [aws_ecr_repository.coordinator.arn, aws_ecr_repository.worker.arn]
      },
      {
        Sid      = "ReadConfiguredSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.secret_arns
      },
      {
        Sid      = "WriteCoordinatorLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.coordinator.arn}:log-stream:coordinator-*"
      }
      ], length(var.secret_kms_key_arns) == 0 ? [] : [{
        Sid       = "DecryptConfiguredSecretKeys"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = var.secret_kms_key_arns
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" } }
        }], var.cloudwatch_logs_kms_key_arn == "" ? [] : [{
        Sid      = "UseConfiguredCloudWatchLogsKey"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:ReEncrypt*", "kms:Decrypt", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource = var.cloudwatch_logs_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "logs.${var.aws_region}.amazonaws.com" }
        }
    }])
  })
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "guillermo-"
  role        = aws_iam_role.instance.name
}

resource "aws_security_group" "alb" {
  name_prefix = "guillermo-alb-"
  description = "Public HTTPS edge for Guillermo"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.allowed_https_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS clients"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_instance" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.instance.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "instance" {
  name_prefix = "guillermo-ec2-"
  description = "Dedicated Guillermo host; no SSH ingress"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "instance_from_alb" {
  security_group_id            = aws_security_group.instance.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "Coordinator HTTP only from ALB"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "instance_outbound" {
  security_group_id = aws_security_group.instance.id
  description       = "Package, AWS API, GitHub, OpenAI, npm and repository egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_lb" "this" {
  name                       = "guillermo"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.alb_public_subnet_ids
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "coordinator" {
  name        = "guillermo-coordinator"
  port        = 3000
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "jira_webhook" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.coordinator.arn
  }

  condition {
    path_pattern {
      values = ["/webhooks/jira"]
    }
  }

  condition {
    http_request_method {
      values = ["POST"]
    }
  }
}

resource "aws_instance" "coordinator" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = var.ec2_subnet_id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = var.root_volume_size_gib
  }

  user_data_base64 = base64encode(templatefile("${path.module}/bootstrap.sh.tftpl", {
    aws_region                   = var.aws_region
    coordinator_repository_url   = aws_ecr_repository.coordinator.repository_url
    worker_repository_url        = aws_ecr_repository.worker.repository_url
    runtime_secret_arn           = var.runtime_secret_arn
    private_key_secret_arn       = var.github_private_key_secret_arn
    coordinator_log_group_name   = aws_cloudwatch_log_group.coordinator.name
    initial_release_tag          = var.release_tag
    compose_base64               = base64encode(file("${path.module}/../compose.yaml"))
    host_deploy_script_base64    = base64encode(file("${path.module}/../host-deploy-release.sh"))
    render_runtime_script_base64 = base64encode(file("${path.module}/../render-runtime-env.sh"))
  }))
  user_data_replace_on_change = false

  # Cloud-init is a create-time bootstrap. Updating the stored EC2 user data
  # neither reruns it nor safely updates the live host; use an explicit instance
  # replacement when bootstrap changes must be installed on an existing host.
  lifecycle {
    ignore_changes = [user_data_base64]
  }

  tags = { Name = "guillermo-coordinator" }

  depends_on = [aws_iam_role_policy.runtime, aws_iam_role_policy_attachment.ssm]
}

resource "aws_lb_target_group_attachment" "coordinator" {
  target_group_arn = aws_lb_target_group.coordinator.arn
  target_id        = aws_instance.coordinator.id
  port             = 3000
}

resource "aws_route53_record" "this" {
  count   = local.create_dns ? 1 : 0
  zone_id = var.route53_hosted_zone_id
  name    = var.dns_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
