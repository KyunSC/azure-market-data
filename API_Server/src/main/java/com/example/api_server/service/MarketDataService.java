package com.example.api_server.service;

import com.example.api_server.dto.MarketDataResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.converter.StringHttpMessageConverter;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.stream.Collectors;

@Service
public class MarketDataService {

    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${azure.function.url:http://localhost:7071/api/MarketDataFunction}")
    private String functionUrl;

    public MarketDataResponse getMarketData(List<String> tickers) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        // Manually build JSON string
        String tickersJson = tickers.stream()
                .map(t -> "\"" + t + "\"")
                .collect(Collectors.joining(","));
        String jsonBody = "{\"tickers\":[" + tickersJson + "]}";

        HttpEntity<String> request = new HttpEntity<>(jsonBody, headers);

        return restTemplate.postForObject(functionUrl, request, MarketDataResponse.class);
    }
}
