# Test API endpoints
$baseUrl = "http://localhost:8787/api"

Write-Host "=== Testing /api/kb_search with x-tenant-id header ===" -ForegroundColor Cyan
$headers = @{'x-tenant-id'='test-business-1'}
$body = '{"query":"ceny","limit":5}'
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/kb_search" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
    Write-Host "SUCCESS!" -ForegroundColor Green
    if ($response.results) {
        Write-Host "✓ Returns { results: [...] } format" -ForegroundColor Green
        Write-Host "Results count: $($response.results.Count)"
    } else {
        Write-Host "✗ Missing 'results' wrapper" -ForegroundColor Red
    }
    $response | ConvertTo-Json -Depth 3
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Response: $($_.ErrorDetails.Message)"
    }
}

Write-Host "`n=== Testing /api/ingest with x-tenant-id header ===" -ForegroundColor Cyan
$body2 = '{"url":"https://www.cutegory.cz/kadernictvi-brno","language":"cs","chunk_size":1000}'
try {
    $response2 = Invoke-RestMethod -Uri "$baseUrl/ingest" -Method Post -Headers $headers -ContentType 'application/json' -Body $body2
    Write-Host "SUCCESS!" -ForegroundColor Green
    Write-Host "Response structure:" -ForegroundColor Green
    $response2 | ConvertTo-Json -Depth 3
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Response: $($_.ErrorDetails.Message)"
    }
}


