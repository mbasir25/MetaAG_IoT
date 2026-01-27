import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.REACT_APP_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true // needed for frontend usage
});

export async function createEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text
  });
  return response.data[0].embedding;
}

// Stub: you can replace this with real vector similarity
export async function searchEmbeddingIndex(indexName, embeddingVector) {
  return [
    { text: "Urea" },
    { text: "Compost" },
    { text: "Ammonium Nitrate" }
  ];
}