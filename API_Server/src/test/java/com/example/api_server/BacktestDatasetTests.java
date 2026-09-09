package com.example.api_server;

import com.example.api_server.controller.BacktestController;
import com.example.api_server.service.BacktestDatasetService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class BacktestDatasetTests {
    @TempDir Path directory;

    @Test void servesCatalogAndImmutableVersions() throws Exception {
        var controller = new BacktestController(new BacktestDatasetService(directory.toString()));
        assertEquals(503, controller.catalog().getStatusCode().value());
        Files.writeString(directory.resolve("index.json"), "{\"schemaVersion\":1,\"datasets\":[]}");
        assertEquals(200, controller.catalog().getStatusCode().value());
        assertEquals("no-cache", controller.catalog().getHeaders().getCacheControl());
        String id = "qqq-5m-" + "a".repeat(64);
        assertEquals(404, controller.dataset(id).getStatusCode().value());
        Files.writeString(directory.resolve(id + ".json"), "{\"bars\":2}");
        assertEquals("{\"bars\":2}", controller.dataset(id).getBody());
        assertTrue(controller.dataset(id).getHeaders().getCacheControl().contains("immutable"));
    }

    @Test void rejectsArbitraryPaths() {
        var controller = new BacktestController(new BacktestDatasetService(directory.toString()));
        for (String id : new String[]{"../pom.xml", "index", "QQQ", "https://example.com"})
            assertEquals(400, controller.dataset(id).getStatusCode().value());
    }

    @Test void routesHttpRequests() throws Exception {
        var mvc = MockMvcBuilders.standaloneSetup(new BacktestController(new BacktestDatasetService(directory.toString()))).build();
        Files.writeString(directory.resolve("index.json"), "{\"schemaVersion\":1,\"datasets\":[]}");
        mvc.perform(get("/api/backtest/datasets")).andExpect(status().isOk())
                .andExpect(content().contentType("application/json"))
                .andExpect(jsonPath("$.schemaVersion").value(1));
        mvc.perform(get("/api/backtest/datasets/unknown")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/backtest/datasets/qqq-5m-" + "b".repeat(64))).andExpect(status().isNotFound());
    }
}
