import {
    v
} from "convex/values";
import {
    query
} from "./_generated/server";

export const getGroupExpenses = query({
    args: {
        groupId: v.id("groups")
    },
    handler: async (ctx, {
        groupId
    }) => {
        // Use centralized getCurrentUser function
        const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

        const group = await ctx.db.get(groupId);
        if (!group) throw new Error("Group not found");

        if (!group.members.some((m) => m.userId === currentUser._id))
            throw new Error("You are not a member of this group");


        const expenses = await ctx.db
            .query("expenses")
            .withIndex("by_group", (q) => q.eq("groupId", groupId))
            .collect();

        const settlements = await ctx.db
            .query("settlements")
            .filter((q) => q.eq(q.field("groupId"), groupId))
            .collect();


        /* ----------  member map ---------- */
        const memberDetails = await Promise.all(
            group.members.map(async (m) => {
                const u = await ctx.db.get(m.userId);
                return {
                    id: u._id,
                    name: u.name,
                    imageUrl: u.imageUrl,
                    role: m.role
                };
            })
        );
        const ids = memberDetails.map((m) => m.id);

        /* ----------  ledgers ---------- */
        // total net balance (old behaviour)
        // Balance Cal SetUp
        // Init totals objects to track overall balance for each user 
        const totals = Object.fromEntries(ids.map((id) => [id, 0]));
        // pair‑wise ledger  debtor -> creditor -> amount
        // Create a 2D ledger to track who owes whom
        const ledger = {};
        ids.forEach((a) => {
            ledger[a] = {};
            ids.forEach((b) => {
                if (a !== b) ledger[a][b] = 0;
            });
        });

        // Apply Expenses to Balances
        // Example:
        // - Expense 1: user1 paid $60, split equally among all 3 users ($20 each)
        // - After applying this expense:
        //   - totals = { "user1": +40, "user2": -20, "user3": -20 }
        //   - ledger = {
        //    "user1": { "user2": 0, "user3": 0 },
        //    "user2": { "user1 }

        /* ----------  apply expenses ---------- */
        for (const exp of expenses) {
            const payer = exp.paidByUserId;
            for (const split of exp.splits) {
                if (split.userId === payer || split.paid) continue; // skip payer & settled
                const debtor = split.userId;
                const amt = split.amount;
                // Update totals 
                totals[payer] += amt; // payer gains credit
                totals[debtor] -= amt; // Debtor goes into debt

                ledger[debtor][payer] += amt; // debtor owes payer
            }
        }


        // Apply Settlements to Balances
        // - Settlement: user2 paid $10 to user1
        // - After applying this settlement:
        //   - totals = { "user1": +30, "user2": -10, "user3": -20 }
        //   - ledger = {
        //       "user1": { "user2": 0, "user3": 0 },
        //       "user2": { "user1": 10, "user3": 0 },
        //       "user3": { "user1": 20, "user2": 0 }
        //     }
        //   - This means user2 now owes user1 only $10, and user3 still owes
        //     user1 $20

        /* ----------  apply settlements ---------- */
        for (const s of settlements) // Update totals 
        {
            totals[s.paidByUserId] += s.amount;
            totals[s.receivedByUserId] -= s.amount;

            ledger[s.paidByUserId][s.receivedByUserId] -= s.amount; // they paid back
        }

        /* ----------  net the pair‑wise ledger ---------- */
     //

        // ids.forEach((a) => {
        //     ids.forEach((b) => {
        //         if (a >= b) return; // visit each unordered pair once
        //         const diff = ledger[a][b] - ledger[b][a];
        //         if (diff > 0) {
        //             ledger[a][b] = diff;
        //             ledger[b][a] = 0;
        //         } else if (diff < 0) {
        //             ledger[b][a] = -diff;
        //             ledger[a][b] = 0;
        //         } else {
        //             ledger[a][b] = ledger[b][a] = 0;
        //         }
        //     });
        // });



        /* ----------  shape the response ---------- */
        // Final balances with details
        // Create a comprehensive balance sheet for each member
        const balances = memberDetails.map((m) => ({
            ...m,
            totalBalance: totals[m.id],
            owes: Object.entries(ledger[m.id])
                .filter(([, v]) => v > 0)
                .map(([to, amount]) => ({
                    to,
                    amount
                })),
            owedBy: ids
                .filter((other) => ledger[other][m.id] > 0)
                .map((other) => ({
                    from: other,
                    amount: ledger[other][m.id]
                })),
        }));


        const userLookupMap = {}; // Map of userId to member details
        memberDetails.forEach((member) => // populate the map
             {
            userLookupMap[member.id] = member;
        });

        return {
            // Group details
            group: {
                id: group._id,
                name: group.name,
                description: group.description,
            },
            members: memberDetails, // Basic member info
            expenses, // All expenses in the group
            settlements, // All settlements in the group
            balances, // Calculated balances for each member
            userLookupMap, // Map of user IDs to member details
        }; // end return


    }, // end handler
})  // end query getGroupExpenses