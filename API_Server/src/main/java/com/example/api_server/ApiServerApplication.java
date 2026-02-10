package com.example.api_server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

@SpringBootApplication
@EnableCaching
public class ApiServerApplication {

    private static final Logger logger = LoggerFactory.getLogger(ApiServerApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(ApiServerApplication.class, args);
        logger.info("API Server started successfully");
    }
}
