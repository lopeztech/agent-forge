# HTTP API (v2) — cheaper than REST API, and we don't need REST-API
# features (request validators, API keys, usage plans) for an inbound
# webhook. GitHub posts to POST /webhook; the verifier Lambda does the
# rest.

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-webhooks"
  protocol_type = "HTTP"
  description   = "Inbound GitHub webhooks for agent-forge. Single route: POST /webhook."
}

resource "aws_apigatewayv2_integration" "verifier" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.verifier_function_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.verifier.id}"
}

# CloudWatch log group for access logs. Helpful for debugging GitHub
# delivery issues from outside the Lambda (TLS errors, 4xx without
# the Lambda ever firing, etc.).
resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name_prefix}-webhooks"
  retention_in_days = var.access_log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      protocol           = "$context.protocol"
      responseLength     = "$context.responseLength"
      integrationStatus  = "$context.integrationStatus"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

# Allow API Gateway to invoke the verifier Lambda for this API's routes.
resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.verifier_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
