/**
 * Load test questions for autocannon.
 *
 * This module exports an array of request specs that autocannon
 * POSTs to the API. Each request includes a Spanish question.
 *
 * Usage:
 *   autocannon --harness ./tests/load/questions.mjs http://localhost:3000
 *
 * The harness format exports either:
 *   - A function `(context)` returning an array of requests, or
 *   - A default array of requests
 *
 * https://github.com/mcollina/autocannon#harness
 */

const REQUESTS = [
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
    body: JSON.stringify({
      question: "¿Cuál es el plazo de matrícula ordinaria?",
    }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
    body: JSON.stringify({ question: "¿Cuál es el horario del comedor?" }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
    body: JSON.stringify({ question: "¿Cuándo empiezan las clases?" }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
    body: JSON.stringify({
      question: "¿Cuál es el precio del abono de transporte?",
    }),
  },
  {
    method: "POST",
    path: "/api/v1/questions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
    body: JSON.stringify({ question: "¿Qué días se imparte ajedrez?" }),
  },
  {
    method: "GET",
    path: "/health",
    headers: {
      Authorization: "Bearer test-auth-token-with-at-least-32-characters",
    },
  },
  {
    method: "GET",
    path: "/health/live",
  },
];

export default REQUESTS;
