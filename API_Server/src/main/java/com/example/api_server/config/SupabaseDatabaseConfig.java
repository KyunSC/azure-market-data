package com.example.api_server.config;

import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jpa.EntityManagerFactoryBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import javax.sql.DataSource;
import java.util.HashMap;
import java.util.Map;

// @Configuration  // TEMPORARILY DISABLED
/// @EnableJpaRepositories(
//         basePackages = "com.example.api_server.repository.supabase",
//         entityManagerFactoryRef = "supabaseEntityManagerFactory",
//         transactionManagerRef = "supabaseTransactionManager"
// )
public class SupabaseDatabaseConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.supabase")
    public DataSourceProperties supabaseDataSourceProperties() {
        return new DataSourceProperties();
    }

    @Bean
    public DataSource supabaseDataSource() {
        return supabaseDataSourceProperties()
                .initializeDataSourceBuilder()
                .build();
    }

    @Bean
    public LocalContainerEntityManagerFactoryBean supabaseEntityManagerFactory(
            EntityManagerFactoryBuilder builder) {
        Map<String, Object> properties = new HashMap<>();
        properties.put("hibernate.hbm2ddl.auto", "update");
        properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
        properties.put("hibernate.show_sql", "true");

        return builder
                .dataSource(supabaseDataSource())
                .packages("com.example.api_server.entity")
                .persistenceUnit("supabase")
                .properties(properties)
                .build();
    }

    @Bean
    public PlatformTransactionManager supabaseTransactionManager(
            @Qualifier("supabaseEntityManagerFactory") EntityManagerFactory entityManagerFactory) {
        return new JpaTransactionManager(entityManagerFactory);
    }
}
