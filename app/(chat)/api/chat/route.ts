import { convertToCoreMessages, Message, streamText } from "ai";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google"; // Import the provider

// Removed the specific import of geminiProModel from "@/ai"
// import { geminiProModel } from "@/ai";

// Keep your existing imports for actions, auth, db, utils etc.
import {
  generateReservationPrice,
  generateSampleFlightSearchResults,
  generateSampleFlightStatus,
  generateSampleSeatSelection,
} from "@/ai/actions";
import { auth } from "@/app/(auth)/auth";
import {
  createReservation,
  deleteChatById,
  getChatById,
  getReservationById,
  saveChat,
} from "@/db/queries";
import { generateUUID } from "@/lib/utils";

// --- Initialize the Google AI provider ---
// Ensure GOOGLE_GENERATIVE_AI_API_KEY is set in your environment variables
const google = createGoogleGenerativeAI();

// --- Define the specific model ---
const targetModel = google('models/gemini-2.5-pro-preview-03-25');
// ------------------------------------
// Important Note: Ensure this specific preview model name ('gemini-2.5-pro-preview-03-25')
// is accessible with your API key and project setup via the @ai-sdk/google provider.
// Preview models might have limited access or specific naming conventions within the SDK.
// If you encounter errors, verify the model name in the Google AI documentation for the SDK
// or try a generally available model like 'gemini-1.5-pro-latest'.
// ------------------------------------


export async function POST(request: Request) {
  const { id, messages }: { id: string; messages: Array<Message> } =
    await request.json();

  const session = await auth();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const coreMessages = convertToCoreMessages(messages).filter(
    (message) => message.content.length > 0,
  );

  try {
    const result = await streamText({
      // --- Use the specific model instance defined above ---
      model: targetModel,
      // -----------------------------------------------------
      system: `\n
          - you help users book flights!
          - keep your responses limited to a sentence.
          - DO NOT output lists.
          - after every tool call, pretend you're showing the result to the user and keep your response limited to a phrase.
          - today's date is ${new Date().toLocaleDateString()}.
          - ask follow up questions to nudge user into the optimal flow
          - ask for any details you don't know, like name of passenger, etc.'
          - C and D are aisle seats, A and F are window seats, B and E are middle seats
          - assume the most popular airports for the origin and destination
          - here's the optimal flow
            - search for flights
            - choose flight
            - select seats
            - create reservation (ask user whether to proceed with payment or change reservation)
            - authorize payment (requires user consent, wait for user to finish payment and let you know when done)
            - display boarding pass (DO NOT display boarding pass without verifying payment)
          '
        `,
      messages: coreMessages,
      tools: {
        // --- Your existing tools definitions remain unchanged ---
        getWeather: {
          description: "Get the current weather at a location",
          parameters: z.object({
            latitude: z.number().describe("Latitude coordinate"),
            longitude: z.number().describe("Longitude coordinate"),
          }),
          execute: async ({ latitude, longitude }) => {
            const response = await fetch(
              `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}¤t=temperature_2m&hourly=temperature_2m&daily=sunrise,sunset&timezone=auto`,
            );
            if (!response.ok) {
              console.error("Failed to fetch weather:", response.statusText);
              return { error: `Failed to fetch weather: ${response.statusText}` };
            }
            const weatherData = await response.json();
            return weatherData;
          },
        },
        displayFlightStatus: {
          description: "Display the status of a flight",
          parameters: z.object({
            flightNumber: z.string().describe("Flight number"),
            date: z.string().describe("Date of the flight"),
          }),
          execute: async ({ flightNumber, date }) => {
            const flightStatus = await generateSampleFlightStatus({
              flightNumber,
              date,
            });
            return flightStatus;
          },
        },
        searchFlights: {
          description: "Search for flights based on the given parameters",
          parameters: z.object({
            origin: z.string().describe("Origin airport or city"),
            destination: z.string().describe("Destination airport or city"),
          }),
          execute: async ({ origin, destination }) => {
            const results = await generateSampleFlightSearchResults({
              origin,
              destination,
            });
            return results;
          },
        },
        selectSeats: {
          description: "Select seats for a flight",
          parameters: z.object({
            flightNumber: z.string().describe("Flight number"),
          }),
          execute: async ({ flightNumber }) => {
            const seats = await generateSampleSeatSelection({ flightNumber });
            return seats;
          },
        },
        createReservation: {
          description: "Display pending reservation details",
          parameters: z.object({
            seats: z.string().array().describe("Array of selected seat numbers"),
            flightNumber: z.string().describe("Flight number"),
            departure: z.object({
              cityName: z.string().describe("Name of the departure city"),
              airportCode: z.string().describe("Code of the departure airport"),
              timestamp: z.string().describe("ISO 8601 date of departure"),
              gate: z.string().describe("Departure gate"),
              terminal: z.string().describe("Departure terminal"),
            }),
            arrival: z.object({
              cityName: z.string().describe("Name of the arrival city"),
              airportCode: z.string().describe("Code of the arrival airport"),
              timestamp: z.string().describe("ISO 8601 date of arrival"),
              gate: z.string().describe("Arrival gate"),
              terminal: z.string().describe("Arrival terminal"),
            }),
            passengerName: z.string().describe("Name of the passenger"),
          }),
          execute: async (props) => {
            const { totalPriceInUSD } = await generateReservationPrice(props);
            const session = await auth(); // Re-check session within execute if needed

            const reservationId = generateUUID();

            if (session && session.user && session.user.id) {
              await createReservation({
                id: reservationId,
                userId: session.user.id,
                details: { ...props, totalPriceInUSD },
              });

              // Return the ID along with other details so the AI knows it
              return { id: reservationId, ...props, totalPriceInUSD };
            } else {
              // This shouldn't happen if initial check passed, but good practice
              return {
                error: "User session lost. Cannot create reservation.",
              };
            }
          },
        },
        authorizePayment: {
          description:
            "Inform the user they need to authorize payment and wait for their confirmation.",
          parameters: z.object({
            reservationId: z
              .string()
              .describe("Unique identifier for the reservation"),
          }),
          // This tool might not need an execute if it's just telling the AI to prompt the user.
          // Or, it could trigger a UI element on the frontend if integrated.
          // For this example, it just returns the ID for context.
          execute: async ({ reservationId }) => {
            console.log(`AI is prompting user to authorize payment for reservation ${reservationId}`);
            // In a real app, you might trigger a frontend state change here.
            return { message: `User needs to authorize payment for reservation ${reservationId}.`, reservationId };
          },
        },
        verifyPayment: {
          description: "Verify payment status for a reservation.",
          parameters: z.object({
            reservationId: z
              .string()
              .describe("Unique identifier for the reservation"),
          }),
          execute: async ({ reservationId }) => {
            try {
                const reservation = await getReservationById({ id: reservationId });
                // Ensure reservation exists and belongs to the user if necessary (security)
                 if (!reservation) {
                     return { error: `Reservation ${reservationId} not found.` };
                 }
                // Add user check if getReservationById doesn't handle it
                // const currentSession = await auth();
                // if (reservation.userId !== currentSession?.user?.id) {
                //    return { error: "Unauthorized to verify this reservation." };
                // }

                return { hasCompletedPayment: reservation.hasCompletedPayment };
            } catch (error) {
                console.error(`Error verifying payment for ${reservationId}:`, error);
                return { error: "Could not verify payment status." };
            }
          },
        },
        displayBoardingPass: {
          description: "Display a boarding pass if payment is verified.",
          parameters: z.object({
            // Parameters match the execute function below
            reservationId: z.string().describe("Unique identifier for the reservation"),
            // The AI should ideally get these details from the reservation or context
            // but defining them helps ensure the AI provides necessary info
             passengerName: z.string().describe("Name of the passenger, in title case"),
             flightNumber: z.string().describe("Flight number"),
             seat: z.string().describe("Seat number"),
             departure: z.object({ /* ... departure details ... */ }),
             arrival: z.object({ /* ... arrival details ... */ }),
          }),
           // It's often better to fetch fresh reservation details here rather than trusting the AI's potentially stale parameters
          execute: async ({ reservationId }) => {
             console.log(`Attempting to display boarding pass for reservation ${reservationId}`);
            try {
                 const reservation = await getReservationById({ id: reservationId });
                 if (!reservation) {
                     return { error: `Reservation ${reservationId} not found.` };
                 }
                 // **Crucial Check:** Verify payment before returning boarding pass data
                 if (!reservation.hasCompletedPayment) {
                     return { error: "Payment not completed for this reservation. Cannot display boarding pass." };
                 }
                 // Construct the boarding pass data from the *verified* reservation details
                 const boardingPassData = {
                     reservationId: reservation.id,
                     passengerName: reservation.details.passengerName,
                     flightNumber: reservation.details.flightNumber,
                     seat: reservation.details.seats.join(", "), // Assuming seats is an array
                     departure: reservation.details.departure,
                     arrival: reservation.details.arrival,
                     // Add any other needed fields like airportName if available in reservation.details
                 };
                 return boardingPassData; // Return the actual data for display
            } catch (error) {
                console.error(`Error retrieving details for boarding pass ${reservationId}:`, error);
                return { error: "Could not retrieve boarding pass details." };
            }
          },
        },
      },
      onFinish: async ({ responseMessages }) => {
        // Ensure session user ID is still valid before saving
        if (session.user && session.user.id) {
          try {
            // Save the original user messages and the final assistant responses
            await saveChat({
              id, // The chat ID from the request
              messages: [...coreMessages, ...responseMessages], // Combine history with new AI responses
              userId: session.user.id,
            });
          } catch (error) {
            console.error("Failed to save chat:", error);
            // Decide how to handle save failure - maybe log externally
          }
        }
      },
      experimental_telemetry: {
        isEnabled: true, // Optional: Keep Vercel telemetry enabled
        functionId: "stream-text-flight-booking", // Optional: Custom identifier
      },
    });

    return result.toDataStreamResponse({});

  } catch (error) {
      console.error(`Error in streamText call with model ${targetModel.modelId}:`, error);
      // Provide a structured error response
      let errorMessage = "An error occurred while processing your request.";
      let statusCode = 500;

      if (error instanceof Error) {
            // Check for specific API errors if possible (e.g., from the AI SDK)
            // This part depends on the specific errors thrown by @ai-sdk/google
            if (error.message.includes('permission denied') || error.message.includes('API key') || error.message.includes('quota')) {
                errorMessage = `AI service error: ${error.message}`;
                statusCode = 403; // Or 429 for quota
            } else if (error.message.includes('model') && error.message.includes('not found')) {
                errorMessage = `AI model error: ${error.message}`;
                statusCode = 400; // Bad request likely due to invalid model
            } else {
                 errorMessage = `Internal server error: ${error.message}`;
            }
      }

      return new Response(JSON.stringify({ error: errorMessage }), {
          status: statusCode,
          headers: { 'Content-Type': 'application/json' },
      });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new Response(JSON.stringify({ error: "Chat ID is required" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await auth();

  if (!session || !session.user?.id) { // Check for user ID specifically
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
     });
  }

  try {
    const chat = await getChatById({ id });

    // Check if chat exists first
    if (!chat) {
         return new Response(JSON.stringify({ error: "Chat not found" }), {
             status: 404,
             headers: { 'Content-Type': 'application/json' },
         });
    }

    // Verify ownership
    if (chat.userId !== session.user.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, // Use 403 Forbidden for ownership issues
          headers: { 'Content-Type': 'application/json' },
       });
    }

    await deleteChatById({ id });

    // Return a success response, perhaps empty or with a confirmation message
    return new Response(JSON.stringify({ message: "Chat deleted successfully" }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
     });

  } catch (error) {
    console.error(`Error deleting chat ${id}:`, error);
    return new Response(JSON.stringify({ error: "An internal error occurred while deleting the chat." }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
     });
  }
}