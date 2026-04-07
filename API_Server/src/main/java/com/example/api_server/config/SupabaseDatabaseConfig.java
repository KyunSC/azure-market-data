package com.example.api_server.config;

import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jpa.EntityManagerFactoryBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;
import java.util.HashMap;
import java.util.Map;

@Configuration
@EnableTransactionManagement
@EnableJpaRepositories(
        basePackages = "com.example.api_server.repository.supabase",
        entityManagerFactoryRef = "supabaseEntityManagerFactory",
        transactionManagerRef = "supabaseTransactionManager"
)
public class SupabaseDatabaseConfig {

    @Primary
    @Bean
    @ConfigurationProperties("spring.datasource.supabase")
    public DataSourceProperties supabaseDataSourceProperties() {
        return new DataSourceProperties();
    }

    @Primary
    @Bean
    public DataSource supabaseDataSource() {
        HikariDataSource ds = supabaseDataSourceProperties()
                .initializeDataSourceBuilder()
                .type(HikariDataSource.class)
                .build();
        ds.setConnectionTestQuery("SELECT 1");
        ds.setValidationTimeout(3000);
        ds.setConnectionTimeout(10000);       // 10s to acquire a connection
        ds.setMaxLifetime(600000);             // 10 min
        ds.setKeepaliveTime(300000);           // 5 min keepalive probes
        ds.setMinimumIdle(2);
        ds.setMaximumPoolSize(5);
        ds.setIdleTimeout(60000);              // 1 min idle before eviction
        ds.setInitializationFailTimeout(-1);
        return ds;
    }

    @Primary
    @Bean
    public LocalContainerEntityManagerFactoryBean supabaseEntityManagerFactory(
            EntityManagerFactoryBuilder builder) {
        Map<String, Object> properties = new HashMap<>();
        properties.put("hibernate.hbm2ddl.auto", "none");
        properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
        properties.put("hibernate.show_sql", "true");
        // Disable query plan cache — incompatible with PgBouncer transaction mode
        properties.put("hibernate.query.plan_cache_max_size", "1");
        properties.put("hibernate.query.plan_parameter_metadata_max_size", "1");

        return builder
                .dataSource(supabaseDataSource())
                .packages("com.example.api_server.entity")
                .persistenceUnit("supabase")
                .properties(properties)
                .build();
    }

    @Primary
    @Bean
    public PlatformTransactionManager supabaseTransactionManager(
            @Qualifier("supabaseEntityManagerFactory") EntityManagerFactory entityManagerFactory) {
        return new JpaTransactionManager(entityManagerFactory);
    }
}
