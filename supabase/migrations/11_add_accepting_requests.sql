-- Migration to add accepting_requests column to users table
ALTER TABLE users ADD COLUMN accepting_requests BOOLEAN DEFAULT TRUE;
