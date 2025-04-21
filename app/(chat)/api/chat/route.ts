import { convertToCoreMessages, Message, streamText } from "ai";
import { z } from "zod"; // Already imported
import { createGoogleGenerativeAI } from "@ai-sdk/google";

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

// --- Zod Schema for Reservation Details ---
const ReservationDetailsSchema = z.object({
  seats: z.string().array(),
  flightNumber: z.string(),
  departure: z.object({
    cityName: z.string(),
    airportCode: z.string(),
    timestamp: z.string(),
    gate: z.string(),
    terminal: z.string(),
  }),
  arrival: z.object({
    cityName: z.string(),
    airportCode: z.string(),
    timestamp: z.string(),
    gate: z.string(),
    terminal: z.string(),
  }),
  passengerName: z.string(),
  totalPriceInUSD: z.number(), // Make sure this matches what's stored
});
// --- End Schema ---

// --- Initialize the Google AI provider ---
const google = createGoogleGenerativeAI();

// --- Define the specific model ---
const targetModel = google('models/gemini-2.5-pro-preview-03-25');
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
      model: targetModel,
      system: `\n
          - you help users book flights!
          // ... (rest of your system prompt) ...
          '
        `,
      messages: coreMessages,
      tools: {
        // ... other tools (getWeather, searchFlights, etc.) remain the same ...

        createReservation: {
           description: "Display pending reservation details",
           parameters: z.object({ // This defines what AI should PROVIDE
               seats: z.string().array().describe("Array of selected seat numbers"),
               flightNumber: z.string().describe("Flight number"),
               departure: z.object({ /* ... */ }),
               arrival: z.object({ /* ... */ }),
               passengerName: z.string().describe("Name of the passenger"),
            }),
           execute: async (props) => {
               const { totalPriceInUSD } = await generateReservationPrice(props);
               const session = await auth();
               const reservationId = generateUUID();

               if (session?.user?.id) {
                   // Ensure the 'details' object here matches ReservationDetailsSchema
                   const detailsToStore = { ...props, totalPriceInUSD };
                   // Optional: Validate detailsToStore against ReservationDetailsSchema before saving
                   // try { ReservationDetailsSchema.parse(detailsToStore); } catch(e) { console.error("Data mismatch before saving!", e); return {error: "Internal data format error."}}

                   await createReservation({
                       id: reservationId,
                       userId: session.user.id,
                       details: detailsToStore, // Store the combined object
                   });
                   return { id: reservationId, ...detailsToStore }; // Return combined details
               } else {
                   return { error: "User session lost. Cannot create reservation." };
               }
           },
        },

        // ... other tools (authorizePayment, verifyPayment) ...

        displayBoardingPass: {
          description: "Display a boarding pass if payment is verified.",
          // Parameters define what info the AI needs to *initiate* the call
          parameters: z.object({
            reservationId: z.string().describe("Unique identifier for the reservation"),
            // AI doesn't strictly need to provide passengerName etc. here,
            // as we fetch it fresh, but it helps guide the AI.
          }),
           // Fetches fresh data and validates it.
          execute: async ({ reservationId }) => {
             console.log(`Attempting to display boarding pass for reservation ${reservationId}`);
            try {
                 const reservation = await getReservationById({ id: reservationId });
                 if (!reservation) {
                     return { error: `Reservation ${reservationId} not found.` };
                 }
                 if (!reservation.hasCompletedPayment) {
                     return { error: "Payment not completed for this reservation. Cannot display boarding pass." };
                 }

                 // --- PARSE and VALIDATE the details field ---
                 let parsedDetails;
                 try {
                    const validationResult = ReservationDetailsSchema.safeParse(reservation.details);
                    if (!validationResult.success) {
                        console.error(`Reservation details validation failed for ${reservationId}:`, validationResult.error.flatten());
                        return { error: "Invalid reservation details structure in database." };
                    }
                    parsedDetails = validationResult.data;
                 } catch (parseError) {
                     console.error(`Error parsing reservation details for ${reservationId}:`, parseError);
                     return { error: "Could not parse reservation details." };
                 }
                 // --- END PARSE ---

                 // Construct the boarding pass data using the PARSED details
                 const boardingPassData = {
                     reservationId: reservation.id,
                     passengerName: parsedDetails.passengerName,
                     flightNumber: parsedDetails.flightNumber,
                     seat: parsedDetails.seats.join(", "),
                     departure: parsedDetails.departure,
                     arrival: parsedDetails.arrival,
                 };
                 console.log(`Successfully prepared boarding pass data for ${reservationId}`);
                 return boardingPassData;
            } catch (error) {
                console.error(`Error retrieving/processing details for boarding pass ${reservationId}:`, error);
                // Avoid leaking detailed errors to the AI/user unless necessary
                return { error: "An internal error occurred while retrieving boarding pass details." };
            }
          },
        }, // End displayBoardingPass tool
      }, // End tools object
      onFinish: async ({ responseMessages }) => {
        if (session.user?.id) {
          try {
            await saveChat({
              id,
              messages: [...coreMessages, ...responseMessages],
              userId: session.user.id,
            });
          } catch (error) {
            console.error("Failed to save chat:", error);
          }
        }
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "stream-text-flight-booking",
      },
    });

    return result.toDataStreamResponse({});

  } catch (error) {
      console.error(`Error in streamText call with model ${targetModel.modelId}:`, error);
      let errorMessage = "An error occurred while processing your request.";
      let statusCode = 500;

      if (error instanceof Error) {
            // Basic error type checking
            if (error.message.includes('permission denied') || error.message.includes('API key') || error.message.includes('quota')) {
                errorMessage = `AI service error: ${error.message}`;
                statusCode = 403;
            } else if (error.message.includes('model') && error.message.includes('not found')) {
                errorMessage = `AI model error: ${error.message}`;
                statusCode = 400;
            } else {
                 errorMessage = `Internal server error: ${error.message}`;
            }
      }

      return new Response(JSON.stringify({ error: errorMessage }), {
          status: statusCode,
          headers: { 'Content-Type': 'application/json' },
      });
  }
} // End POST handler

export async function DELETE(request: Request) {
  // ... (DELETE handler remains the same as the improved version) ...
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return new Response(JSON.stringify({ error: "Chat ID is required" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = await auth();

    if (!session || !session.user?.id) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
       });
    }

    try {
      const chat = await getChatById({ id });

      if (!chat) {
           return new Response(JSON.stringify({ error: "Chat not found" }), {
               status: 404,
               headers: { 'Content-Type': 'application/json' },
           });
      }

      if (chat.userId !== session.user.id) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
         });
      }

      await deleteChatById({ id });

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
} // End DELETE handler