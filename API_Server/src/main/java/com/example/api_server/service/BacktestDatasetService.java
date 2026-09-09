package com.example.api_server.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.NoSuchFileException;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

/** Artifacts are published atomically by publish_backtest_data.py; no training on requests. */
@Service
public class BacktestDatasetService {
    private final String location;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public BacktestDatasetService(@Value("${backtest.datasets.location:./backtest-data}") String location) {
        this.location = location.replaceAll("/+$", "");
    }

    public ResponseEntity<String> response(String filename, boolean immutable) {
        try {
            String body;
            if (location.startsWith("https://")) {
                var request = HttpRequest.newBuilder(URI.create(location + "/" + filename))
                        .timeout(Duration.ofSeconds(30)).GET().build();
                var result = client.send(request, HttpResponse.BodyHandlers.ofString());
                if (result.statusCode() == 404) return error(immutable ? 404 : 503, "Dataset unavailable");
                if (result.statusCode() != 200) return error(503, "Dataset storage unavailable");
                body = result.body();
            } else {
                body = Files.readString(Path.of(location).resolve(filename));
            }
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON)
                    .header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
                    .body(body);
        } catch (NoSuchFileException e) {
            return error(immutable ? 404 : 503, immutable ? "Dataset version unavailable" : "No datasets published");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return error(503, "Dataset request interrupted");
        } catch (Exception e) {
            return error(503, "Dataset storage unavailable");
        }
    }

    private ResponseEntity<String> error(int status, String message) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON)
                .header("Cache-Control", "no-store").body("{\"message\":\"" + message + "\"}");
    }
}
