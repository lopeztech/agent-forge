output "cluster_name" {
  value       = aws_ecs_cluster.this.name
  description = "ECS cluster name. Agent role modules reference this on their task definitions."
}

output "cluster_arn" {
  value       = aws_ecs_cluster.this.arn
  description = "ECS cluster ARN. Used by Step Functions states_RunTask integration."
}
