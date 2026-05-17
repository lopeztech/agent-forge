# Shared Fargate cluster for every agent role. Per CLAUDE.md, the cluster
# is just a namespace — capacity is per-task on Fargate, not per-cluster.
# Spot is the default capacity provider; on-demand is the fallback for
# retries after a spot reclamation (Step Functions handles the retry).
resource "aws_ecs_cluster" "this" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }
}
