/**
 * Home Purchase Calculator - Frontend Logic
 *
 * This file handles all client-side calculations and UI updates.
 * All formulas match those in formulas.py for consistency.
 */

// =============================================================================
// CONSTANTS (matching formulas.py)
// =============================================================================

const CMHC_RATES = [
    { maxLtv: 0.65, rate: 0.0060 },
    { maxLtv: 0.75, rate: 0.0170 },
    { maxLtv: 0.80, rate: 0.0240 },
    { maxLtv: 0.85, rate: 0.0280 },
    { maxLtv: 0.90, rate: 0.0310 },
    { maxLtv: 0.95, rate: 0.0400 },
];

const CMHC_30_YEAR_SURCHARGE = 0.0020;
const QUEBEC_TVQ_RATE = 0.09975;

const QUEBEC_WELCOME_TAX_BRACKETS = [
    { threshold: 55200, rate: 0.005 },
    { threshold: 276200, rate: 0.010 },
    { threshold: 500000, rate: 0.015 },
    { threshold: 1000000, rate: 0.020 },
    { threshold: Infinity, rate: 0.025 },
];

// Financing source types
const FINANCING_TYPES = {
    mortgage: {
        label: 'Bank Mortgage',
        requiresRepayment: true,
        isLoan: true,
        countsTowardDownPayment: false,
        description: 'Standard mortgage loan from a financial institution'
    },
    celiapp: {
        label: 'CELIAPP',
        requiresRepayment: false,
        isLoan: false,
        countsTowardDownPayment: true,
        description: 'First Home Savings Account - Tax-free withdrawal for first home purchase',
        maxContribution: 40000
    },
    rrsp: {
        label: 'RRSP (Home Buyers\' Plan)',
        requiresRepayment: true,
        repaymentYears: 15,
        isLoan: false,
        countsTowardDownPayment: true,
        description: 'Home Buyers\' Plan - Must repay to RRSP over 15 years (starting 2nd year after withdrawal)',
        maxWithdrawal: 60000  // Per person as of 2024
    },
    tfsa: {
        label: 'TFSA',
        requiresRepayment: false,
        isLoan: false,
        countsTowardDownPayment: true,
        description: 'Tax-Free Savings Account - No repayment required'
    },
    joint_account: {
        label: 'Joint Account',
        requiresRepayment: false,
        isLoan: false,
        countsTowardDownPayment: false,  // Kept separate
        description: 'Joint savings - Kept separate from down payment (for moving costs, renovations, etc.)'
    },
    parents_loan: {
        label: 'Parent\'s Loan',
        requiresRepayment: true,
        isLoan: true,
        countsTowardDownPayment: true,
        isAutoCalculated: true,
        description: 'Loan from parents to cover the gap between your savings and required down payment'
    },
    other_loan: {
        label: 'Other Loan',
        requiresRepayment: true,
        isLoan: true,
        countsTowardDownPayment: false,
        description: 'Any other loan (personal loan, line of credit, etc.)'
    },
    other_savings: {
        label: 'Other Savings',
        requiresRepayment: false,
        isLoan: false,
        countsTowardDownPayment: true,
        description: 'Other savings or gifts'
    }
};

// =============================================================================
// STATE
// =============================================================================

let financingSources = [];
let owners = [];
let renovations = [];
let otherDebts = [];
let warnings = [];
let paymentChart = null;
let equityChart = null;
let downPaymentMode = 'amount'; // 'amount' or 'percent'

const STORAGE_KEY = 'homeBudgetCalculator';

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize charts first
    initChart();
    initEquityChart();

    // Load and display formulas
    loadFormulas();

    // Try to load saved data, or initialize with defaults
    if (!loadFromStorage()) {
        // Add default financing sources
        addFinancingSource('Bank Mortgage', 'mortgage', { isAutoFillMortgage: true });
        addFinancingSource('CELIAPP', 'celiapp');
        addFinancingSource('RRSP', 'rrsp');
        addFinancingSource('TFSA', 'tfsa');
        addFinancingSource('Joint Account', 'joint_account');
        addFinancingSource('Parent\'s Loan', 'parents_loan', { isAutoCalculated: true });

        // Add initial owner
        addOwner('Person 1');
    }

    // Initial calculation
    calculate();
});

// =============================================================================
// CALCULATION FUNCTIONS (matching formulas.py)
// =============================================================================

function calculateLtv(purchasePrice, downPayment) {
    if (purchasePrice <= 0) return 0;
    return (purchasePrice - downPayment) / purchasePrice;
}

function getCmhcRate(ltv, is30Year = false) {
    let rate = 0;
    for (const bracket of CMHC_RATES) {
        if (ltv <= bracket.maxLtv) {
            rate = bracket.rate;
            break;
        }
    }
    if (is30Year) rate += CMHC_30_YEAR_SURCHARGE;
    return rate;
}

function calculateCmhc(purchasePrice, downPayment, is30Year = false) {
    const mortgageAmount = purchasePrice - downPayment;
    const ltv = calculateLtv(purchasePrice, downPayment);
    const downPaymentPercent = purchasePrice > 0 ? (downPayment / purchasePrice) * 100 : 0;
    const cmhcRequired = ltv > 0.80;

    const premiumRate = getCmhcRate(ltv, is30Year);
    const cmhcPremium = cmhcRequired ? mortgageAmount * premiumRate : 0;
    const quebecTax = cmhcPremium * QUEBEC_TVQ_RATE;
    const totalCmhcCost = cmhcPremium + quebecTax;
    const totalMortgage = mortgageAmount + totalCmhcCost;

    return {
        mortgageAmount,
        ltv,
        ltvPercent: ltv * 100,
        downPaymentPercent,
        cmhcRequired,
        premiumRate,
        premiumRatePercent: premiumRate * 100,
        cmhcPremium,
        quebecTax,
        totalCmhcCost,
        totalMortgage
    };
}

function calculateMonthlyPayment(principal, annualRate, termMonths) {
    if (principal <= 0 || termMonths <= 0) {
        return { monthlyPayment: 0, totalPayments: 0, totalInterest: 0 };
    }

    const monthlyRate = (annualRate / 100) / 12;

    if (monthlyRate === 0) {
        return {
            monthlyPayment: principal / termMonths,
            totalPayments: principal,
            totalInterest: 0
        };
    }

    // M = P × [r(1+r)^n] / [(1+r)^n - 1]
    const rateFactor = Math.pow(1 + monthlyRate, termMonths);
    const monthlyPayment = principal * (monthlyRate * rateFactor) / (rateFactor - 1);
    const totalPayments = monthlyPayment * termMonths;
    const totalInterest = totalPayments - principal;

    return { monthlyPayment, totalPayments, totalInterest, monthlyRate };
}

function calculatePaymentBreakdown(principal, annualRate, monthlyPayment, currentBalance = null) {
    const balance = currentBalance !== null ? currentBalance : principal;
    const monthlyRate = (annualRate / 100) / 12;
    const interestPortion = balance * monthlyRate;
    const principalPortion = monthlyPayment - interestPortion;

    return { interestPortion, principalPortion };
}

function calculateWelcomeTax(purchasePrice) {
    let totalTax = 0;
    let remaining = purchasePrice;
    let previousThreshold = 0;
    const breakdown = [];

    for (const bracket of QUEBEC_WELCOME_TAX_BRACKETS) {
        const bracketMax = bracket.threshold - previousThreshold;
        const amountInBracket = Math.min(remaining, bracketMax);

        if (amountInBracket > 0) {
            const taxInBracket = amountInBracket * bracket.rate;
            breakdown.push({
                from: previousThreshold,
                to: Math.min(bracket.threshold, purchasePrice),
                rate: bracket.rate,
                amount: amountInBracket,
                tax: taxInBracket
            });
            totalTax += taxInBracket;
            remaining -= amountInBracket;
        }

        previousThreshold = bracket.threshold;
        if (remaining <= 0) break;
    }

    return { breakdown, totalTax };
}

function calculateAffordability(totalMonthlyCosts, grossMonthlyIncome) {
    if (grossMonthlyIncome <= 0) {
        return { ratio: 0, percent: 0, status: 'unknown', statusColor: 'gray' };
    }

    const ratio = totalMonthlyCosts / grossMonthlyIncome;
    const percent = ratio * 100;

    let status, statusColor;
    if (percent <= 30) {
        status = 'Affordable';
        statusColor = 'green';
    } else if (percent <= 40) {
        status = 'Caution';
        statusColor = 'yellow';
    } else {
        status = 'High Risk';
        statusColor = 'red';
    }

    return { ratio, percent, status, statusColor };
}

// =============================================================================
// UI UPDATE FUNCTIONS
// =============================================================================

function formatCurrency(amount) {
    return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: 'CAD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

function formatPercent(value, decimals = 1) {
    return value.toFixed(decimals) + '%';
}

function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || 0 : 0;
}

function calculate() {
    // Gather all input values
    const askingPrice = getInputValue('askingPrice');
    const evaluationPrice = getInputValue('evaluationPrice');
    const offerPrice = getInputValue('offerPrice');
    const squareFootage = getInputValue('squareFootage');
    const downPayment = getDownPaymentAmount();
    const is30Year = document.getElementById('is30Year')?.checked || false;

    // Update down payment converted display when offer price changes
    updateDownPaymentConverted();

    const insurance = getInputValue('insurance');
    const electricity = getInputValue('electricity');
    const upkeep = getInputValue('upkeep');
    const cityTaxesAnnual = getInputValue('cityTaxes');

    const notaryFees = getInputValue('notaryFees');
    const movingBase = getInputValue('movingBase');
    const paintPerSqft = getInputValue('paintPerSqft');

    // === PROPERTY PRICING ===
    if (askingPrice > 0 && offerPrice > 0) {
        const percentOfAsking = (offerPrice / askingPrice) * 100;
        const percentOfEvaluation = evaluationPrice > 0 ? (offerPrice / evaluationPrice) * 100 : 0;

        document.getElementById('percentOfAsking').textContent = formatPercent(percentOfAsking);
        document.getElementById('percentOfEvaluation').textContent = evaluationPrice > 0 ? formatPercent(percentOfEvaluation) : '--';
        document.getElementById('offerPercentages').classList.remove('hidden');
    } else {
        document.getElementById('offerPercentages').classList.add('hidden');
    }

    // === CMHC ===
    const cmhc = calculateCmhc(offerPrice, downPayment, is30Year);

    // === AUTO-FILL BANK MORTGAGE (first financing source) ===
    updateBankMortgageAmount(cmhc.totalMortgage);

    if (offerPrice > 0 && downPayment > 0) {
        document.getElementById('downPaymentPercent').textContent = formatPercent(cmhc.downPaymentPercent);
        document.getElementById('ltvRatio').textContent = formatPercent(cmhc.ltvPercent);
        document.getElementById('premiumRate').textContent = cmhc.cmhcRequired ? formatPercent(cmhc.premiumRatePercent, 2) : 'N/A (≥20% down)';
        document.getElementById('cmhcPremium').textContent = formatCurrency(cmhc.cmhcPremium);
        document.getElementById('quebecTax').textContent = formatCurrency(cmhc.quebecTax);
        document.getElementById('totalCmhc').textContent = formatCurrency(cmhc.totalCmhcCost);
        document.getElementById('totalMortgage').textContent = formatCurrency(cmhc.totalMortgage);
        document.getElementById('cmhcDisplay').classList.remove('hidden');
    } else {
        document.getElementById('cmhcDisplay').classList.add('hidden');
    }

    // === CITY TAXES MONTHLY ===
    const cityTaxesMonthly = cityTaxesAnnual / 12;
    document.getElementById('cityTaxesMonthly').textContent = cityTaxesAnnual > 0 ? `= ${formatCurrency(cityTaxesMonthly)}/mo` : '';

    // === WELCOME TAX ===
    const welcomeTax = calculateWelcomeTax(offerPrice);
    document.getElementById('welcomeTaxDisplay').textContent = formatCurrency(welcomeTax.totalTax);

    // === MOVING COSTS ===
    const paintTotal = squareFootage * paintPerSqft;
    document.getElementById('paintTotal').textContent = formatCurrency(paintTotal);
    const totalMovingCost = movingBase + paintTotal;

    // === RENOVATIONS TOTAL ===
    const totalRenovations = renovations.reduce((sum, r) => sum + (r.amount || 0), 0);

    // === ONE-TIME COSTS TOTAL ===
    const totalOneTime = welcomeTax.totalTax + notaryFees + totalMovingCost + totalRenovations;
    document.getElementById('oneTimeTotal').textContent = formatCurrency(totalOneTime);

    // === FINANCING SOURCES ===
    // First pass: Read all amounts and calculate savings toward down payment
    // (must process ALL sources before calculating parent's loan gap)
    let totalSavingsForDownPayment = 0;
    warnings = [];  // Reset warnings

    financingSources.forEach((source, index) => {
        if (!source) return;

        const sourceType = source.sourceType || document.getElementById(`financing-type-${index}`)?.value;
        const typeConfig = FINANCING_TYPES[sourceType];

        // For auto-calculated sources (parent's loan), skip reading amount - it will be set below
        // For auto-fill mortgage, use source.amount (set by CMHC calculation)
        // For all others, read from input
        let amount;
        if (typeConfig?.isAutoCalculated) {
            // Skip - will be calculated after we know the gap
            amount = 0;
        } else if (source.isAutoFillMortgage) {
            amount = source.amount;
        } else {
            amount = getInputValue(`financing-amount-${index}`);
        }

        source.amount = amount;
        source.sourceType = sourceType;

        // Sum up savings that count toward down payment (excluding auto-calculated like parent's loan)
        if (typeConfig && typeConfig.countsTowardDownPayment && !typeConfig.isAutoCalculated && amount > 0) {
            totalSavingsForDownPayment += amount;

            // Check for RRSP warnings
            if (sourceType === 'rrsp' && amount > 0) {
                if (amount > FINANCING_TYPES.rrsp.maxWithdrawal) {
                    warnings.push({
                        type: 'warning',
                        source: 'RRSP',
                        message: `Maximum HBP withdrawal is ${formatCurrency(FINANCING_TYPES.rrsp.maxWithdrawal)} per person. You may need to reduce this amount.`
                    });
                }
            }

            // Check CELIAPP max
            if (sourceType === 'celiapp' && amount > FINANCING_TYPES.celiapp.maxContribution) {
                warnings.push({
                    type: 'warning',
                    source: 'CELIAPP',
                    message: `Maximum CELIAPP contribution is ${formatCurrency(FINANCING_TYPES.celiapp.maxContribution)}. Amount exceeds limit.`
                });
            }
        }
    });

    // NOW calculate parent's loan (gap between savings and required down payment)
    // This happens AFTER all other down payment sources have been summed
    const downPaymentGap = Math.max(0, downPayment - totalSavingsForDownPayment);
    updateParentsLoanAmount(downPaymentGap);

    // Second pass: Calculate loan payments
    let totalMonthlyLoanPayment = 0;
    let totalInterestFirstMonth = 0;
    let totalPrincipalFirstMonth = 0;
    const loanPaymentDetails = [];
    let rrspMonthlyRepayment = 0;

    financingSources.forEach((source, index) => {
        if (!source) return;

        const sourceType = source.sourceType;
        const typeConfig = FINANCING_TYPES[sourceType];
        const amount = source.amount;

        if (!typeConfig) return;

        // Handle loans (mortgage, parent's loan, other loans)
        if (typeConfig.isLoan && amount > 0) {
            const rate = getInputValue(`financing-rate-${index}`);
            const termYears = getInputValue(`financing-term-${index}`);
            const termMonths = termYears * 12;

            source.rate = rate;
            source.termMonths = termMonths;

            const payment = calculateMonthlyPayment(amount, rate, termMonths);
            const breakdown = calculatePaymentBreakdown(amount, rate, payment.monthlyPayment);

            source.monthlyPayment = payment.monthlyPayment;
            source.interestPortion = breakdown.interestPortion;
            source.principalPortion = breakdown.principalPortion;

            if (payment.monthlyPayment > 0) {
                totalMonthlyLoanPayment += payment.monthlyPayment;
                totalInterestFirstMonth += breakdown.interestPortion;
                totalPrincipalFirstMonth += breakdown.principalPortion;

                loanPaymentDetails.push({
                    name: source.name,
                    sourceType: sourceType,
                    interest: breakdown.interestPortion,
                    principal: breakdown.principalPortion,
                    amount: amount,
                    rate: rate,
                    termMonths: termMonths,
                    monthlyPayment: payment.monthlyPayment
                });
            }

            // Update display
            const paymentDisplay = document.getElementById(`financing-payment-${index}`);
            if (paymentDisplay) {
                if (payment.monthlyPayment > 0) {
                    paymentDisplay.textContent = `Monthly: ${formatCurrency(payment.monthlyPayment)}`;
                } else if (termMonths === 0) {
                    paymentDisplay.textContent = 'Enter term to calculate payment';
                } else {
                    paymentDisplay.textContent = '';
                }
            }
        } else if (sourceType === 'rrsp' && amount > 0) {
            // RRSP repayment (not a traditional loan, but needs repayment to RRSP)
            rrspMonthlyRepayment = (amount / 15) / 12;  // Annual divided by 12

            const paymentDisplay = document.getElementById(`financing-payment-${index}`);
            if (paymentDisplay) {
                paymentDisplay.innerHTML = `<span class="text-orange-600">RRSP repayment: ${formatCurrency(rrspMonthlyRepayment)}/mo (${formatCurrency(amount / 15)}/yr for 15 yrs)</span>`;
            }
        } else {
            // Non-loan sources
            const paymentDisplay = document.getElementById(`financing-payment-${index}`);
            if (paymentDisplay) {
                if (sourceType === 'joint_account') {
                    paymentDisplay.textContent = 'Kept separate (not for down payment)';
                } else if (typeConfig.countsTowardDownPayment) {
                    paymentDisplay.textContent = amount > 0 ? 'Applied to down payment' : '';
                } else {
                    paymentDisplay.textContent = '';
                }
            }
        }
    });

    // Add RRSP repayment warning to monthly budget considerations
    // RRSP repayment is now shown in the payment breakdown chart, no warning needed

    // Update warnings display
    updateWarningsDisplay();

    // === MONTHLY COSTS ===
    const totalMonthlyCosts = totalMonthlyLoanPayment + insurance + electricity + upkeep + cityTaxesMonthly;

    // === TOTAL INCOME & PER-PERSON DEBTS ===
    let totalGrossIncome = 0;
    let totalOtherDebtPayments = 0;
    const ownerData = [];

    owners.forEach((owner, index) => {
        if (owner === null) return;

        const income = getInputValue(`owner-income-${index}`);
        const carLoan = getInputValue(`owner-car-${index}`);
        const studentLoan = getInputValue(`owner-student-${index}`);
        const personalLoan = getInputValue(`owner-personal-${index}`);
        const creditCard = getInputValue(`owner-credit-${index}`);
        const totalDebts = carLoan + studentLoan + personalLoan + creditCard;

        owner.income = income;
        owner.carLoanPayment = carLoan;
        owner.studentLoanPayment = studentLoan;
        owner.personalLoanPayment = personalLoan;
        owner.creditCardPayment = creditCard;

        totalGrossIncome += income;
        totalOtherDebtPayments += totalDebts;

        // Update per-person debt total display
        const debtsTotalEl = document.getElementById(`owner-debts-total-${index}`);
        if (debtsTotalEl) {
            debtsTotalEl.textContent = totalDebts > 0 ? formatCurrency(totalDebts) + '/mo' : '$0/mo';
        }

        ownerData.push({
            index,
            name: owner.name,
            income,
            totalDebts,
            carLoan,
            studentLoan,
            personalLoan,
            creditCard
        });
    });

    document.getElementById('totalIncome').textContent = formatCurrency(totalGrossIncome);
    document.getElementById('totalOtherDebtPayments').textContent = formatCurrency(totalOtherDebtPayments) + '/mo';

    // === AFFORDABILITY ===
    updateAffordabilityBars({
        totalMonthlyCosts,
        totalGrossIncome,
        mortgagePayment: totalMonthlyLoanPayment,
        propertyTax: cityTaxesMonthly,
        heating: electricity,  // Using electricity as proxy for heating
        otherDebtPayments: totalOtherDebtPayments,
        ownerData,
        rrspMonthlyRepayment
    });

    document.getElementById('totalMonthlyCosts').textContent = formatCurrency(totalMonthlyCosts);
    document.getElementById('totalGrossIncome').textContent = formatCurrency(totalGrossIncome);

    // === UPDATE CHARTS ===
    updateChart({
        loanPaymentDetails,
        insurance,
        electricity,
        upkeep,
        cityTaxes: cityTaxesMonthly,
        rrspMonthlyRepayment
    });

    updateEquityChart({
        propertyValue: offerPrice,
        loanPaymentDetails
    });

    // === UPDATE SUMMARY ===
    document.getElementById('summaryPurchasePrice').textContent = formatCurrency(offerPrice);
    document.getElementById('summaryDownPayment').textContent = formatCurrency(downPayment);
    document.getElementById('summaryCmhc').textContent = formatCurrency(cmhc.totalCmhcCost);
    document.getElementById('summaryMortgage').textContent = formatCurrency(cmhc.totalMortgage);
    document.getElementById('summaryOneTime').textContent = formatCurrency(totalOneTime);
    document.getElementById('summaryTotalCash').textContent = formatCurrency(downPayment + totalOneTime);
    document.getElementById('summaryMonthlyLoan').textContent = formatCurrency(totalMonthlyLoanPayment);
    document.getElementById('summaryMonthlyTotal').textContent = formatCurrency(totalMonthlyCosts);
}

function getStatusClasses(color) {
    const classes = {
        green: 'bg-green-100 text-green-800',
        yellow: 'bg-yellow-100 text-yellow-800',
        red: 'bg-red-100 text-red-800',
        gray: 'bg-gray-100 text-gray-700'
    };
    return classes[color] || classes.gray;
}

// =============================================================================
// AFFORDABILITY BAR INDICATORS
// =============================================================================

function updateAffordabilityBars(data) {
    const { totalMonthlyCosts, totalGrossIncome, mortgagePayment, propertyTax, heating, otherDebtPayments, ownerData, rrspMonthlyRepayment } = data;

    if (totalGrossIncome <= 0) {
        // Reset all indicators
        updateBar('housingCost', 0, '-');
        updatePerPersonRatios();
        return;
    }

    // 1. Housing Cost Ratio (30% rule) - Household level
    const housingCostRatio = (totalMonthlyCosts / totalGrossIncome) * 100;
    const housingCostStatus = housingCostRatio <= 30 ? 'Affordable' :
        housingCostRatio <= 40 ? 'Caution' : 'High Risk';
    updateBar('housingCost', housingCostRatio, housingCostStatus);

    // 2. Per-Person GDS/TDS Ratios
    // Housing costs are shared proportionally based on income contribution
    const gdsHousingCosts = mortgagePayment + propertyTax + heating;

    updatePerPersonRatios(ownerData, totalGrossIncome, gdsHousingCosts, rrspMonthlyRepayment);
}

function updatePerPersonRatios(ownerData = [], totalGrossIncome = 0, gdsHousingCosts = 0, rrspMonthlyRepayment = 0) {
    const container = document.getElementById('perPersonRatios');
    if (!container) return;

    if (!ownerData || ownerData.length === 0 || totalGrossIncome <= 0) {
        container.innerHTML = '<p class="text-sm text-gray-500 text-center py-4">Add household members to see per-person debt ratios</p>';
        return;
    }

    // Split RRSP repayment proportionally
    const rrspPerPerson = rrspMonthlyRepayment / ownerData.length;

    const ratioCards = ownerData.map(owner => {
        const incomeShare = owner.income / totalGrossIncome;
        const housingCostShare = gdsHousingCosts * incomeShare;

        // GDS for this person (their share of housing costs / their income)
        const gdsRatio = owner.income > 0 ? (housingCostShare / owner.income) * 100 : 0;
        const gdsStatus = gdsRatio <= 32 ? 'Excellent' : gdsRatio <= 39 ? 'Acceptable' : 'May Not Qualify';

        // TDS for this person (GDS + their personal debts + their RRSP repayment share)
        const tdsAmount = housingCostShare + owner.totalDebts + rrspPerPerson;
        const tdsRatio = owner.income > 0 ? (tdsAmount / owner.income) * 100 : 0;
        const tdsStatus = tdsRatio <= 40 ? 'Excellent' : tdsRatio <= 44 ? 'Acceptable' : 'May Not Qualify';

        const gdsStatusColor = gdsStatus === 'Excellent' ? 'bg-green-100 text-green-800' :
            gdsStatus === 'Acceptable' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
        const tdsStatusColor = tdsStatus === 'Excellent' ? 'bg-green-100 text-green-800' :
            tdsStatus === 'Acceptable' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';

        return `
            <div class="p-4 border border-gray-200 rounded-lg">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="font-semibold text-gray-800">${owner.name}</h4>
                    <span class="text-xs text-gray-500">${formatPercent(incomeShare * 100)} of income</span>
                </div>

                <!-- GDS -->
                <div class="mb-3">
                    <div class="flex justify-between items-baseline mb-1">
                        <span class="text-xs text-gray-600">GDS (Gross Debt Service)</span>
                        <div class="flex items-baseline gap-2">
                            <span class="text-lg font-bold text-gray-800">${formatPercent(gdsRatio)}</span>
                            <span class="px-2 py-0.5 rounded-full text-xs font-medium ${gdsStatusColor}">${gdsStatus}</span>
                        </div>
                    </div>
                    <div class="relative h-4 bg-gray-200 rounded-full overflow-hidden">
                        <div class="absolute inset-0 flex">
                            <div class="bg-green-400" style="width: 32%"></div>
                            <div class="bg-yellow-400" style="width: 7%"></div>
                            <div class="bg-red-400" style="width: 61%"></div>
                        </div>
                        <div class="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-600 to-blue-700 transition-all duration-500"
                             style="width: ${Math.min(gdsRatio, 100)}%"></div>
                    </div>
                    <div class="text-xs text-gray-500 mt-1">Housing: ${formatCurrency(housingCostShare)}/mo</div>
                </div>

                <!-- TDS -->
                <div>
                    <div class="flex justify-between items-baseline mb-1">
                        <span class="text-xs text-gray-600">TDS (Total Debt Service)</span>
                        <div class="flex items-baseline gap-2">
                            <span class="text-lg font-bold text-gray-800">${formatPercent(tdsRatio)}</span>
                            <span class="px-2 py-0.5 rounded-full text-xs font-medium ${tdsStatusColor}">${tdsStatus}</span>
                        </div>
                    </div>
                    <div class="relative h-4 bg-gray-200 rounded-full overflow-hidden">
                        <div class="absolute inset-0 flex">
                            <div class="bg-green-400" style="width: 40%"></div>
                            <div class="bg-yellow-400" style="width: 4%"></div>
                            <div class="bg-red-400" style="width: 56%"></div>
                        </div>
                        <div class="absolute inset-y-0 left-0 bg-gradient-to-r from-purple-600 to-purple-700 transition-all duration-500"
                             style="width: ${Math.min(tdsRatio, 100)}%"></div>
                    </div>
                    <div class="text-xs text-gray-500 mt-1">
                        Housing: ${formatCurrency(housingCostShare)} + Debts: ${formatCurrency(owner.totalDebts)}${rrspPerPerson > 0 ? ` + RRSP: ${formatCurrency(rrspPerPerson)}` : ''} = ${formatCurrency(tdsAmount)}/mo
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = ratioCards;
}

function updateBar(barName, percent, status) {
    // Update percentage display
    const percentEl = document.getElementById(`${barName}Percent`);
    if (percentEl) {
        percentEl.textContent = formatPercent(percent);
    }

    // Update status badge
    const statusEl = document.getElementById(`${barName}Status`);
    if (statusEl) {
        statusEl.textContent = status;

        // Set status badge color
        let statusClasses = 'px-2 py-1 rounded-full text-xs font-medium ';
        if (status === 'Affordable' || status === 'Excellent') {
            statusClasses += 'bg-green-100 text-green-800';
        } else if (status === 'Caution' || status === 'Acceptable') {
            statusClasses += 'bg-yellow-100 text-yellow-800';
        } else if (status === 'High Risk' || status === 'May Not Qualify') {
            statusClasses += 'bg-red-100 text-red-800';
        } else {
            statusClasses += 'bg-gray-200 text-gray-700';
        }
        statusEl.className = statusClasses;
    }

    // Update fill bar (cap at 100% for display)
    const fillEl = document.getElementById(`${barName}Fill`);
    if (fillEl) {
        const displayPercent = Math.min(percent, 100);
        fillEl.style.width = `${displayPercent}%`;
    }
}

// =============================================================================
// CHART FUNCTIONS
// =============================================================================

function initChart() {
    const ctx = document.getElementById('paymentChart').getContext('2d');

    paymentChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: true,
                    title: {
                        display: true,
                        text: 'Month'
                    },
                    ticks: {
                        maxTicksLimit: 12,
                        callback: function (value, index) {
                            // Show year markers (every 12 months)
                            if (index % 12 === 0) {
                                return 'Year ' + (Math.floor(index / 12) + 1);
                            }
                            return '';
                        }
                    }
                },
                y: {
                    stacked: true,
                    title: {
                        display: true,
                        text: 'Monthly Payment ($)'
                    },
                    ticks: {
                        callback: function (value) {
                            return '$' + value.toLocaleString();
                        }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        title: function (context) {
                            const monthIndex = context[0].dataIndex;
                            const year = Math.floor(monthIndex / 12) + 1;
                            const month = (monthIndex % 12) + 1;
                            return `Year ${year}, Month ${month}`;
                        },
                        label: function (context) {
                            return context.dataset.label + ': ' + formatCurrency(context.raw);
                        },
                        footer: function (context) {
                            const total = context.reduce((sum, item) => sum + item.raw, 0);
                            return 'Total: ' + formatCurrency(total);
                        }
                    }
                },
                legend: {
                    display: true,
                    position: 'bottom'
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            }
        }
    });
}

function updateChart(data) {
    const datasets = [];
    const maxMonths = 360; // 30 years

    // Color palette
    const colors = {
        interest: '#ef4444',  // red
        principal: ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981'],  // blues/purples/greens
        insurance: '#f97316',  // orange
        electricity: '#eab308',  // yellow
        upkeep: '#84cc16',  // lime
        cityTaxes: '#6366f1'  // indigo
    };

    // Generate month labels (1-360)
    const labels = Array.from({ length: maxMonths }, (_, i) => i + 1);

    // Calculate amortization schedule for each loan
    const interestData = new Array(maxMonths).fill(0);
    const principalDataByLoan = {};

    data.loanPaymentDetails.forEach((loan, loanIndex) => {
        const principalData = new Array(maxMonths).fill(0);
        let remainingBalance = loan.amount;
        const monthlyRate = (loan.rate / 100) / 12;
        const monthlyPayment = loan.monthlyPayment || 0;

        for (let month = 0; month < Math.min(loan.termMonths, maxMonths); month++) {
            if (remainingBalance > 0 && monthlyPayment > 0) {
                const interestPortion = remainingBalance * monthlyRate;
                const principalPortion = Math.min(monthlyPayment - interestPortion, remainingBalance);

                interestData[month] += interestPortion;
                principalData[month] = principalPortion;
                remainingBalance -= principalPortion;
            }
        }

        principalDataByLoan[loanIndex] = { name: loan.name, data: principalData };
    });

    // Add combined interest dataset
    if (interestData.some(v => v > 0)) {
        datasets.push({
            label: 'Interest (All Loans)',
            data: interestData,
            backgroundColor: colors.interest,
            borderWidth: 0
        });
    }

    // Add principal datasets for each loan
    Object.entries(principalDataByLoan).forEach(([loanIndex, loanData]) => {
        if (loanData.data.some(v => v > 0)) {
            const color = colors.principal[parseInt(loanIndex) % colors.principal.length];
            datasets.push({
                label: `Principal (${loanData.name})`,
                data: loanData.data,
                backgroundColor: color,
                borderWidth: 0
            });
        }
    });

    // Add RRSP repayment (15 years = 180 months, starting month 24)
    if (data.rrspMonthlyRepayment > 0) {
        const rrspData = new Array(maxMonths).fill(0);
        // RRSP repayment starts in the 2nd year (month 12) and lasts 15 years (180 months)
        for (let month = 12; month < Math.min(12 + 180, maxMonths); month++) {
            rrspData[month] = data.rrspMonthlyRepayment;
        }
        datasets.push({
            label: 'RRSP Repayment',
            data: rrspData,
            backgroundColor: '#f472b6',  // pink
            borderWidth: 0
        });
    }

    // Add other recurring costs (constant over time)
    const otherCosts = [
        { key: 'insurance', label: 'Insurance', color: colors.insurance },
        { key: 'electricity', label: 'Electricity', color: colors.electricity },
        { key: 'upkeep', label: 'Upkeep', color: colors.upkeep },
        { key: 'cityTaxes', label: 'City Taxes', color: colors.cityTaxes }
    ];

    otherCosts.forEach(cost => {
        if (data[cost.key] > 0) {
            datasets.push({
                label: cost.label,
                data: new Array(maxMonths).fill(data[cost.key]),
                backgroundColor: cost.color,
                borderWidth: 0
            });
        }
    });

    paymentChart.data.labels = labels;
    paymentChart.data.datasets = datasets;
    paymentChart.update();

    // Update legend with first month breakdown
    updateChartLegend(data);
}

function updateChartLegend(data) {
    const legendItems = [];
    const colors = {
        interest: '#ef4444',
        principal: ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981'],
        rrsp: '#f472b6',
        insurance: '#f97316',
        electricity: '#eab308',
        upkeep: '#84cc16',
        cityTaxes: '#6366f1'
    };

    // Add loan interest (combined)
    const totalInterest = data.loanPaymentDetails.reduce((sum, l) => sum + l.interest, 0);
    if (totalInterest > 0) {
        legendItems.push({ label: 'Interest', color: colors.interest, value: totalInterest });
    }

    // Add principal for each loan
    data.loanPaymentDetails.forEach((loan, i) => {
        if (loan.principal > 0) {
            const color = colors.principal[i % colors.principal.length];
            legendItems.push({ label: `Principal (${loan.name})`, color, value: loan.principal });
        }
    });

    // Add RRSP repayment (shows as 0 first year, then starts in year 2)
    if (data.rrspMonthlyRepayment > 0) {
        legendItems.push({ label: 'RRSP Repayment (starts Year 2)', color: colors.rrsp, value: data.rrspMonthlyRepayment });
    }

    // Add other costs
    if (data.insurance > 0) {
        legendItems.push({ label: 'Insurance', color: colors.insurance, value: data.insurance });
    }
    if (data.electricity > 0) {
        legendItems.push({ label: 'Electricity', color: colors.electricity, value: data.electricity });
    }
    if (data.upkeep > 0) {
        legendItems.push({ label: 'Upkeep', color: colors.upkeep, value: data.upkeep });
    }
    if (data.cityTaxes > 0) {
        legendItems.push({ label: 'City Taxes', color: colors.cityTaxes, value: data.cityTaxes });
    }

    // Update legend
    const legendEl = document.getElementById('paymentLegend');
    legendEl.innerHTML = legendItems.map(item => `
        <div class="flex items-center">
            <span class="w-3 h-3 rounded-full mr-2" style="background-color: ${item.color}"></span>
            <span class="text-gray-600">${item.label}:</span>
            <span class="ml-auto font-medium">${formatCurrency(item.value)}</span>
        </div>
    `).join('');
}

function initEquityChart() {
    const ctx = document.getElementById('equityChart').getContext('2d');

    equityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Year'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Amount ($)'
                    },
                    ticks: {
                        callback: function (value) {
                            return '$' + value.toLocaleString();
                        }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        title: function (context) {
                            return `Year ${context[0].label}`;
                        },
                        label: function (context) {
                            return context.dataset.label + ': ' + formatCurrency(context.raw);
                        }
                    }
                },
                legend: {
                    display: true,
                    position: 'bottom'
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            }
        }
    });
}

function updateEquityChart(data) {
    const { propertyValue, loanPaymentDetails } = data;
    const maxYears = 30;
    const labels = Array.from({ length: maxYears + 1 }, (_, i) => i);

    // Calculate remaining balance for each loan at each year end
    const equityData = [];
    const remainingDebtData = [];
    const propertyValueData = new Array(maxYears + 1).fill(propertyValue);

    for (let year = 0; year <= maxYears; year++) {
        const monthIndex = year * 12;
        let totalRemainingDebt = 0;

        loanPaymentDetails.forEach(loan => {
            if (loan.amount > 0 && loan.monthlyPayment > 0) {
                let remainingBalance = loan.amount;
                const monthlyRate = (loan.rate / 100) / 12;

                for (let month = 0; month < Math.min(monthIndex, loan.termMonths); month++) {
                    if (remainingBalance > 0) {
                        const interestPortion = remainingBalance * monthlyRate;
                        const principalPortion = Math.min(loan.monthlyPayment - interestPortion, remainingBalance);
                        remainingBalance -= principalPortion;
                    }
                }
                totalRemainingDebt += Math.max(0, remainingBalance);
            }
        });

        remainingDebtData.push(totalRemainingDebt);
        equityData.push(propertyValue - totalRemainingDebt);
    }

    const datasets = [
        {
            label: 'Property Value',
            data: propertyValueData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 2,
            fill: false,
            tension: 0
        },
        {
            label: 'Remaining Debt',
            data: remainingDebtData,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderWidth: 2,
            fill: false,
            tension: 0.1
        },
        {
            label: 'Your Equity',
            data: equityData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            borderWidth: 3,
            fill: true,
            tension: 0.1
        }
    ];

    equityChart.data.labels = labels;
    equityChart.data.datasets = datasets;
    equityChart.update();

    // Update equity legend
    const initialEquityEl = document.getElementById('initialEquity');
    const finalEquityEl = document.getElementById('finalEquity');
    if (initialEquityEl) {
        initialEquityEl.textContent = formatCurrency(equityData[0] || 0);
    }
    if (finalEquityEl) {
        finalEquityEl.textContent = formatCurrency(equityData[equityData.length - 1] || 0);
    }
}

// =============================================================================
// DYNAMIC LIST FUNCTIONS
// =============================================================================

function addFinancingSource(defaultName = '', sourceType = 'other_savings', options = {}, savedData = null) {
    const index = financingSources.length;
    const typeConfig = FINANCING_TYPES[sourceType] || FINANCING_TYPES.other_savings;
    const name = defaultName || typeConfig.label;

    const isAutoFillMortgage = options.isAutoFillMortgage || savedData?.isAutoFillMortgage || false;
    const isAutoCalculated = options.isAutoCalculated || savedData?.isAutoCalculated || typeConfig.isAutoCalculated || false;

    financingSources.push({
        name,
        sourceType,
        amount: savedData?.amount || 0,
        rate: savedData?.rate || 0,
        termMonths: savedData?.termMonths || 0,
        isAutoFillMortgage,
        isAutoCalculated
    });

    const container = document.getElementById('financingSources');
    const div = document.createElement('div');
    div.id = `financing-source-${index}`;

    // Color coding based on type
    let borderColor = 'border-gray-200';
    let bgColor = '';
    if (sourceType === 'mortgage') {
        borderColor = 'border-blue-200';
        bgColor = 'bg-blue-50/30';
    } else if (typeConfig.countsTowardDownPayment) {
        borderColor = 'border-green-200';
        bgColor = 'bg-green-50/30';
    } else if (sourceType === 'joint_account') {
        borderColor = 'border-purple-200';
        bgColor = 'bg-purple-50/30';
    } else if (sourceType === 'parents_loan') {
        borderColor = 'border-orange-200';
        bgColor = 'bg-orange-50/30';
    }

    div.className = `p-4 border ${borderColor} ${bgColor} rounded-lg`;

    // Build status badge (only show auto-fill/auto-calculated status)
    let statusBadge = '';
    if (isAutoFillMortgage) {
        statusBadge = '<span class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">Auto-filled from mortgage</span>';
    } else if (isAutoCalculated) {
        statusBadge = '<span class="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">Auto-calculated gap</span>';
    }

    // Amount field properties
    const isAmountReadonly = isAutoFillMortgage || isAutoCalculated;
    const amountClass = isAmountReadonly ? 'input-field text-sm bg-gray-100' : 'input-field text-sm';
    const amountReadonly = isAmountReadonly ? 'readonly' : '';

    // Build type selector options
    const typeOptions = Object.entries(FINANCING_TYPES).map(([key, config]) =>
        `<option value="${key}" ${sourceType === key ? 'selected' : ''}>${config.label}</option>`
    ).join('');

    // Show loan fields for mortgage and loans
    const showLoanFields = typeConfig.isLoan;

    div.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
                <input type="text" id="financing-name-${index}" value="${name}"
                       class="font-medium text-gray-800 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none px-1 max-w-48"
                       onchange="financingSources[${index}].name = this.value; saveToStorage()">
                ${statusBadge}
            </div>
            <button onclick="removeFinancingSource(${index})" class="text-red-500 hover:text-red-700 text-sm">Remove</button>
        </div>
        <div class="grid grid-cols-2 gap-3">
            <div>
                <label class="block text-xs text-gray-500 mb-1">Type</label>
                <select id="financing-type-${index}" class="input-field text-sm" onchange="changeFinancingType(${index}); calculate(); saveToStorage()">
                    ${typeOptions}
                </select>
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">Amount ($)</label>
                <input type="number" id="financing-amount-${index}" class="${amountClass}" placeholder="0"
                       value="${savedData?.amount || ''}" ${amountReadonly}
                       oninput="calculate(); saveToStorage()">
            </div>
        </div>
        <div id="financing-loan-fields-${index}" class="grid grid-cols-2 gap-3 mt-3" style="display: ${showLoanFields ? 'grid' : 'none'}">
            <div>
                <label class="block text-xs text-gray-500 mb-1">Interest Rate (%)</label>
                <input type="number" id="financing-rate-${index}" class="input-field text-sm" placeholder="${sourceType === 'parents_loan' ? '0' : '5.5'}" step="0.1"
                       value="${savedData?.rate || ''}"
                       oninput="calculate(); saveToStorage()">
            </div>
            <div>
                <label class="block text-xs text-gray-500 mb-1">Term (years)</label>
                <input type="number" id="financing-term-${index}" class="input-field text-sm" placeholder="${sourceType === 'mortgage' ? '25' : '10'}"
                       value="${savedData?.termMonths ? savedData.termMonths / 12 : ''}"
                       oninput="calculate(); saveToStorage()">
            </div>
        </div>
        <div id="financing-payment-${index}" class="mt-3 text-sm font-medium text-blue-600"></div>
    `;

    container.appendChild(div);
}

function changeFinancingType(index) {
    const selectEl = document.getElementById(`financing-type-${index}`);
    const newType = selectEl.value;
    const source = financingSources[index];

    if (source) {
        source.sourceType = newType;
        const typeConfig = FINANCING_TYPES[newType];

        // Update loan fields visibility
        const loanFields = document.getElementById(`financing-loan-fields-${index}`);
        if (loanFields) {
            loanFields.style.display = typeConfig.isLoan ? 'grid' : 'none';
        }

        // Update auto-calculated status
        source.isAutoCalculated = typeConfig.isAutoCalculated || false;
        source.isAutoFillMortgage = newType === 'mortgage' && index === 0;
    }
}

function updateBankMortgageAmount(totalMortgage) {
    // Find the first financing source that is the auto-fill mortgage
    const mortgageIndex = financingSources.findIndex(s => s && s.isAutoFillMortgage);
    if (mortgageIndex === -1) return;

    const amountInput = document.getElementById(`financing-amount-${mortgageIndex}`);
    if (amountInput && totalMortgage > 0) {
        amountInput.value = Math.round(totalMortgage);
        financingSources[mortgageIndex].amount = totalMortgage;
    } else if (amountInput) {
        amountInput.value = '';
        financingSources[mortgageIndex].amount = 0;
    }
}

function updateParentsLoanAmount(gapAmount) {
    // Find the parent's loan financing source
    const parentsLoanIndex = financingSources.findIndex(s => s && s.isAutoCalculated && s.sourceType === 'parents_loan');
    if (parentsLoanIndex === -1) return;

    const amountInput = document.getElementById(`financing-amount-${parentsLoanIndex}`);
    if (amountInput) {
        if (gapAmount > 0) {
            amountInput.value = Math.round(gapAmount);
            financingSources[parentsLoanIndex].amount = gapAmount;
        } else {
            amountInput.value = '';
            financingSources[parentsLoanIndex].amount = 0;
        }
    }
}

function updateWarningsDisplay() {
    const warningsEl = document.getElementById('warningsDisplay');
    if (!warningsEl) return;

    if (warnings.length === 0) {
        warningsEl.classList.add('hidden');
        return;
    }

    warningsEl.classList.remove('hidden');

    const warningsList = warnings.map(w => {
        let bgColor = 'bg-blue-50 border-blue-200';
        let textColor = 'text-blue-800';
        let icon = 'ℹ️';

        if (w.type === 'warning') {
            bgColor = 'bg-yellow-50 border-yellow-200';
            textColor = 'text-yellow-800';
            icon = '⚠️';
        } else if (w.type === 'budget') {
            bgColor = 'bg-purple-50 border-purple-200';
            textColor = 'text-purple-800';
            icon = '💰';
        }

        return `
            <div class="${bgColor} border ${textColor} p-3 rounded-lg">
                <div class="font-medium">${icon} ${w.source}</div>
                <div class="text-sm mt-1">${w.message}</div>
            </div>
        `;
    }).join('');

    warningsEl.innerHTML = `
        <h3 class="font-semibold text-gray-800 mb-3">Important Notes & Warnings</h3>
        <div class="space-y-2">
            ${warningsList}
        </div>
    `;
}

function removeFinancingSource(index) {
    const el = document.getElementById(`financing-source-${index}`);
    if (el) el.remove();
    financingSources[index] = null;  // Mark as removed but keep indices stable
    calculate();
    saveToStorage();
}

function addOwner(defaultName = '', savedData = null) {
    const index = owners.length;
    const name = defaultName || `Person ${index + 1}`;

    owners.push({
        name,
        income: savedData?.income || 0,
        carLoanPayment: savedData?.carLoanPayment || 0,
        studentLoanPayment: savedData?.studentLoanPayment || 0,
        personalLoanPayment: savedData?.personalLoanPayment || 0,
        creditCardPayment: savedData?.creditCardPayment || 0
    });

    const container = document.getElementById('owners');
    const div = document.createElement('div');
    div.id = `owner-${index}`;
    div.className = 'p-4 border border-gray-200 rounded-lg bg-gray-50/50';
    div.innerHTML = `
        <div class="flex items-center justify-between mb-3">
            <input type="text" id="owner-name-${index}" value="${name}"
                   class="font-semibold text-gray-800 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none px-1"
                   onchange="owners[${index}].name = this.value; updatePerPersonRatios(); saveToStorage()">
            <button onclick="removeOwner(${index})" class="text-red-500 hover:text-red-700 text-sm px-2">Remove</button>
        </div>

        <div class="grid grid-cols-2 gap-3 mb-3">
            <div>
                <label class="block text-xs text-gray-500 mb-1">Monthly Gross Income ($)</label>
                <input type="number" id="owner-income-${index}" class="input-field text-sm"
                       placeholder="0" value="${savedData?.income || ''}" oninput="calculate(); saveToStorage()">
            </div>
            <div class="flex items-end">
                <button onclick="toggleOwnerDebts(${index})" id="owner-debts-toggle-${index}"
                        class="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
                    <span id="owner-debts-arrow-${index}" class="transform transition-transform">▶</span>
                    Other Debts
                    <span id="owner-debts-total-${index}" class="text-gray-500 ml-1">$0/mo</span>
                </button>
            </div>
        </div>

        <div id="owner-debts-${index}" class="hidden mt-3 pt-3 border-t border-gray-200 space-y-3">
            <p class="text-xs text-gray-500">Monthly payments for existing debts (affects your TDS ratio)</p>
            <div class="grid grid-cols-2 gap-3">
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Car Loan ($/mo)</label>
                    <input type="number" id="owner-car-${index}" class="input-field text-sm" placeholder="0"
                           value="${savedData?.carLoanPayment || ''}"
                           oninput="calculate(); saveToStorage()">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Student Loan ($/mo)</label>
                    <input type="number" id="owner-student-${index}" class="input-field text-sm" placeholder="0"
                           value="${savedData?.studentLoanPayment || ''}"
                           oninput="calculate(); saveToStorage()">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Personal Loan ($/mo)</label>
                    <input type="number" id="owner-personal-${index}" class="input-field text-sm" placeholder="0"
                           value="${savedData?.personalLoanPayment || ''}"
                           oninput="calculate(); saveToStorage()">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">Credit Card Min ($/mo)</label>
                    <input type="number" id="owner-credit-${index}" class="input-field text-sm" placeholder="0"
                           value="${savedData?.creditCardPayment || ''}"
                           oninput="calculate(); saveToStorage()">
                </div>
            </div>
        </div>
    `;

    container.appendChild(div);
}

function toggleOwnerDebts(index) {
    const debtsSection = document.getElementById(`owner-debts-${index}`);
    const arrow = document.getElementById(`owner-debts-arrow-${index}`);
    if (debtsSection && arrow) {
        debtsSection.classList.toggle('hidden');
        arrow.style.transform = debtsSection.classList.contains('hidden') ? '' : 'rotate(90deg)';
    }
}

function removeOwner(index) {
    if (owners.filter(o => o !== null).length <= 1) return;  // Keep at least one
    const el = document.getElementById(`owner-${index}`);
    if (el) el.remove();
    owners[index] = null;
    calculate();
    saveToStorage();
}

function addRenovation(savedDesc = '', savedAmount = null) {
    const index = renovations.length;

    renovations.push({ description: savedDesc, amount: savedAmount || 0 });

    const container = document.getElementById('renovations');
    const div = document.createElement('div');
    div.id = `renovation-${index}`;
    div.className = 'flex items-center gap-2';
    div.innerHTML = `
        <input type="text" id="renovation-desc-${index}" class="flex-grow input-field text-sm"
               placeholder="Description" value="${savedDesc}"
               onchange="renovations[${index}].description = this.value; saveToStorage()">
        <span class="text-gray-500">$</span>
        <input type="number" id="renovation-amount-${index}" class="w-28 input-field text-sm"
               placeholder="0" value="${savedAmount || ''}"
               oninput="renovations[${index}].amount = parseFloat(this.value) || 0; calculate(); saveToStorage()">
        <button onclick="removeRenovation(${index})" class="text-red-500 hover:text-red-700 text-sm">×</button>
    `;

    container.appendChild(div);
}

function removeRenovation(index) {
    const el = document.getElementById(`renovation-${index}`);
    if (el) el.remove();
    renovations[index] = null;
    calculate();
    saveToStorage();
}

function suggestUpkeep() {
    const offerPrice = getInputValue('offerPrice');
    if (offerPrice > 0) {
        const suggested = (offerPrice * 0.01) / 12;
        document.getElementById('upkeep').value = Math.round(suggested);
        calculate();
        saveToStorage();
    }
}

// =============================================================================
// DOWN PAYMENT MODE FUNCTIONS
// =============================================================================

function setDownPaymentMode(mode) {
    const offerPrice = getInputValue('offerPrice');
    const currentValue = getInputValue('downPayment');

    // Update button styles
    const amountBtn = document.getElementById('downPaymentModeAmount');
    const percentBtn = document.getElementById('downPaymentModePercent');
    const input = document.getElementById('downPayment');

    if (mode === 'amount') {
        amountBtn.className = 'px-3 py-2 text-sm bg-blue-500 text-white';
        percentBtn.className = 'px-3 py-2 text-sm bg-gray-100 text-gray-700 hover:bg-gray-200';
        input.placeholder = '50,000';
        input.step = '1000';

        // Convert from percent to amount if switching modes
        if (downPaymentMode === 'percent' && offerPrice > 0 && currentValue > 0) {
            const amount = (currentValue / 100) * offerPrice;
            input.value = Math.round(amount);
        }
    } else {
        amountBtn.className = 'px-3 py-2 text-sm bg-gray-100 text-gray-700 hover:bg-gray-200';
        percentBtn.className = 'px-3 py-2 text-sm bg-blue-500 text-white';
        input.placeholder = '10';
        input.step = '0.5';

        // Convert from amount to percent if switching modes
        if (downPaymentMode === 'amount' && offerPrice > 0 && currentValue > 0) {
            const percent = (currentValue / offerPrice) * 100;
            input.value = percent.toFixed(1);
        }
    }

    downPaymentMode = mode;
    updateDownPaymentConverted();
    calculate();
    saveToStorage();
}

function onDownPaymentChange(source) {
    updateDownPaymentConverted();
    calculate();
    saveToStorage();
}

function updateDownPaymentConverted() {
    const offerPrice = getInputValue('offerPrice');
    const inputValue = getInputValue('downPayment');
    const convertedEl = document.getElementById('downPaymentConverted');

    if (offerPrice <= 0 || inputValue <= 0) {
        convertedEl.textContent = '';
        return;
    }

    if (downPaymentMode === 'amount') {
        // Show as percentage
        const percent = (inputValue / offerPrice) * 100;
        convertedEl.textContent = `= ${formatPercent(percent)} of purchase price`;
    } else {
        // Show as dollar amount
        const amount = (inputValue / 100) * offerPrice;
        convertedEl.textContent = `= ${formatCurrency(amount)}`;
    }
}

function getDownPaymentAmount() {
    const offerPrice = getInputValue('offerPrice');
    const inputValue = getInputValue('downPayment');

    if (downPaymentMode === 'percent') {
        return (inputValue / 100) * offerPrice;
    }
    return inputValue;
}

// =============================================================================
// LOCAL STORAGE FUNCTIONS
// =============================================================================

function saveToStorage() {
    const data = {
        // Property pricing
        askingPrice: getInputValue('askingPrice'),
        evaluationPrice: getInputValue('evaluationPrice'),
        offerPrice: getInputValue('offerPrice'),
        squareFootage: getInputValue('squareFootage'),

        // Down payment
        downPayment: getInputValue('downPayment'),
        downPaymentMode: downPaymentMode,
        is30Year: document.getElementById('is30Year')?.checked || false,

        // Monthly costs
        insurance: getInputValue('insurance'),
        electricity: getInputValue('electricity'),
        upkeep: getInputValue('upkeep'),
        cityTaxes: getInputValue('cityTaxes'),

        // One-time costs
        notaryFees: getInputValue('notaryFees'),
        movingBase: getInputValue('movingBase'),
        paintPerSqft: getInputValue('paintPerSqft'),

        // Dynamic lists
        financingSources: financingSources.filter(s => s !== null).map(s => ({
            name: s.name,
            sourceType: s.sourceType,
            amount: s.amount,
            rate: s.rate,
            termMonths: s.termMonths,
            isAutoFillMortgage: s.isAutoFillMortgage,
            isAutoCalculated: s.isAutoCalculated
        })),
        owners: owners.filter(o => o !== null).map(o => ({
            name: o.name,
            income: o.income,
            carLoanPayment: o.carLoanPayment || 0,
            studentLoanPayment: o.studentLoanPayment || 0,
            personalLoanPayment: o.personalLoanPayment || 0,
            creditCardPayment: o.creditCardPayment || 0
        })),
        renovations: renovations.filter(r => r !== null).map(r => ({
            description: r.description,
            amount: r.amount
        }))
    };

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('Failed to save to localStorage:', e);
    }
}

function loadFromStorage() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return false;

        const data = JSON.parse(saved);

        // Property pricing
        if (data.askingPrice) document.getElementById('askingPrice').value = data.askingPrice;
        if (data.evaluationPrice) document.getElementById('evaluationPrice').value = data.evaluationPrice;
        if (data.offerPrice) document.getElementById('offerPrice').value = data.offerPrice;
        if (data.squareFootage) document.getElementById('squareFootage').value = data.squareFootage;

        // Down payment
        if (data.downPayment) document.getElementById('downPayment').value = data.downPayment;
        if (data.downPaymentMode) {
            downPaymentMode = data.downPaymentMode;
            // Update button styles
            const amountBtn = document.getElementById('downPaymentModeAmount');
            const percentBtn = document.getElementById('downPaymentModePercent');
            const input = document.getElementById('downPayment');
            if (downPaymentMode === 'percent') {
                amountBtn.className = 'px-3 py-2 text-sm bg-gray-100 text-gray-700 hover:bg-gray-200';
                percentBtn.className = 'px-3 py-2 text-sm bg-blue-500 text-white';
                input.placeholder = '10';
                input.step = '0.5';
            }
        }
        if (data.is30Year) document.getElementById('is30Year').checked = data.is30Year;

        // Monthly costs
        if (data.insurance) document.getElementById('insurance').value = data.insurance;
        if (data.electricity) document.getElementById('electricity').value = data.electricity;
        if (data.upkeep) document.getElementById('upkeep').value = data.upkeep;
        if (data.cityTaxes) document.getElementById('cityTaxes').value = data.cityTaxes;

        // One-time costs
        if (data.notaryFees) document.getElementById('notaryFees').value = data.notaryFees;
        if (data.movingBase) document.getElementById('movingBase').value = data.movingBase;
        if (data.paintPerSqft) document.getElementById('paintPerSqft').value = data.paintPerSqft;

        // Financing sources
        if (data.financingSources && data.financingSources.length > 0) {
            data.financingSources.forEach(source => {
                const options = {
                    isAutoFillMortgage: source.isAutoFillMortgage,
                    isAutoCalculated: source.isAutoCalculated
                };
                addFinancingSource(source.name, source.sourceType || 'other_savings', options, source);
            });
        } else {
            // Default if no saved sources
            addFinancingSource('Bank Mortgage', 'mortgage', { isAutoFillMortgage: true });
        }

        // Owners (with debt data)
        if (data.owners && data.owners.length > 0) {
            data.owners.forEach(owner => {
                // Handle both old format (just income) and new format (with debts)
                const savedData = typeof owner.income === 'number' ? owner : { income: owner.income };
                addOwner(owner.name, savedData);
            });
        } else {
            addOwner('Person 1');
        }

        // Renovations
        if (data.renovations && data.renovations.length > 0) {
            data.renovations.forEach(reno => {
                addRenovation(reno.description, reno.amount);
            });
        }

        return true;
    } catch (e) {
        console.warn('Failed to load from localStorage:', e);
        return false;
    }
}

function clearStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
    } catch (e) {
        console.warn('Failed to clear localStorage:', e);
    }
}

// =============================================================================
// JSON IMPORT/EXPORT FUNCTIONS
// =============================================================================

function exportToJson() {
    const data = {
        // Property pricing
        askingPrice: getInputValue('askingPrice'),
        evaluationPrice: getInputValue('evaluationPrice'),
        offerPrice: getInputValue('offerPrice'),
        squareFootage: getInputValue('squareFootage'),

        // Down payment
        downPayment: getInputValue('downPayment'),
        downPaymentMode: downPaymentMode,
        is30Year: document.getElementById('is30Year')?.checked || false,

        // Monthly costs
        insurance: getInputValue('insurance'),
        electricity: getInputValue('electricity'),
        upkeep: getInputValue('upkeep'),
        cityTaxes: getInputValue('cityTaxes'),

        // One-time costs
        notaryFees: getInputValue('notaryFees'),
        movingBase: getInputValue('movingBase'),
        paintPerSqft: getInputValue('paintPerSqft'),

        // Dynamic lists
        financingSources: financingSources.filter(s => s !== null).map(s => ({
            name: s.name,
            sourceType: s.sourceType,
            amount: s.amount,
            rate: s.rate,
            termMonths: s.termMonths,
            isAutoFillMortgage: s.isAutoFillMortgage,
            isAutoCalculated: s.isAutoCalculated
        })),
        owners: owners.filter(o => o !== null).map(o => ({
            name: o.name,
            income: o.income,
            carLoanPayment: o.carLoanPayment || 0,
            studentLoanPayment: o.studentLoanPayment || 0,
            personalLoanPayment: o.personalLoanPayment || 0,
            creditCardPayment: o.creditCardPayment || 0
        })),
        renovations: renovations.filter(r => r !== null).map(r => ({
            description: r.description,
            amount: r.amount
        })),

        // Metadata
        exportedAt: new Date().toISOString(),
        version: '1.0'
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `home-budget-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importFromJson(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);

            // Save to localStorage and reload (reuses existing load logic)
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            location.reload();
        } catch (err) {
            alert('Failed to import JSON file. Please check the file format.');
            console.error('Import error:', err);
        }
    };
    reader.readAsText(file);

    // Reset file input so same file can be imported again
    event.target.value = '';
}

// =============================================================================
// FORMULAS DISPLAY
// =============================================================================

function loadFormulas() {
    const formulas = [
        {
            category: 'Property Pricing',
            items: [
                { name: 'Offer as % of Asking', formula: '(Offer Price ÷ Asking Price) × 100', description: 'Shows how your offer compares to the seller\'s asking price' },
                { name: 'Offer as % of Evaluation', formula: '(Offer Price ÷ Evaluation Price) × 100', description: 'Shows how your offer compares to the appraised value' }
            ]
        },
        {
            category: 'CMHC Insurance',
            items: [
                { name: 'Loan-to-Value Ratio (LTV)', formula: 'LTV = (Purchase Price - Down Payment) ÷ Purchase Price', description: 'Determines CMHC insurance requirement (required if LTV > 80%)' },
                { name: 'CMHC Premium', formula: 'Premium = Mortgage Amount × Premium Rate', description: 'Insurance premium based on LTV bracket' },
                { name: 'CMHC with Quebec Tax', formula: 'Total = Premium × (1 + 9.975%)', description: 'Quebec provincial tax (TVQ) is applied to CMHC premiums' }
            ]
        },
        {
            category: 'Mortgage Payment',
            items: [
                { name: 'Monthly Payment', formula: 'M = P × [r(1+r)ⁿ] ÷ [(1+r)ⁿ - 1]', description: 'P = Principal, r = Monthly rate (annual÷12), n = Number of payments' },
                { name: 'Interest Portion', formula: 'Interest = Remaining Balance × Monthly Rate', description: 'Portion of each payment going to interest' },
                { name: 'Principal Portion', formula: 'Principal = Monthly Payment - Interest', description: 'Portion of each payment reducing the loan balance' }
            ]
        },
        {
            category: 'Quebec Welcome Tax',
            items: [
                { name: 'Welcome Tax Brackets', formula: '0.5% (≤$55,200) + 1.0% ($55,200-$276,200) + 1.5% ($276,200-$500,000) + 2.0% ($500,000-$1M) + 2.5% (>$1M)', description: 'Land transfer tax calculated in brackets' }
            ]
        },
        {
            category: 'Moving Costs',
            items: [
                { name: 'Paint Cost', formula: 'Paint Cost = Square Footage × Cost per Sqft', description: 'Typical: $2-4/sqft DIY, $4-8/sqft professional' }
            ]
        },
        {
            category: 'Monthly Costs',
            items: [
                { name: 'City Taxes Monthly', formula: 'Monthly = Annual City Taxes ÷ 12', description: 'Convert annual property taxes to monthly amount' },
                { name: 'Suggested Upkeep', formula: 'Monthly Upkeep = (Home Value × 1%) ÷ 12', description: 'Rule of thumb: budget 1% of home value annually for maintenance' }
            ]
        },
        {
            category: 'Affordability',
            items: [
                { name: 'Affordability Ratio', formula: 'Ratio = (Total Monthly Costs ÷ Gross Monthly Income) × 100', description: '≤30% = Affordable, 30-40% = Caution, >40% = High Risk' }
            ]
        }
    ];

    const container = document.getElementById('formulasContent');
    container.innerHTML = formulas.map(category => `
        <div class="border-b border-gray-200 pb-4 last:border-b-0">
            <h3 class="font-semibold text-gray-700 mb-2">${category.category}</h3>
            <div class="space-y-3">
                ${category.items.map(item => `
                    <div class="bg-gray-50 p-3 rounded">
                        <div class="font-medium text-gray-800">${item.name}</div>
                        <code class="block text-sm text-blue-600 mt-1 font-mono">${item.formula}</code>
                        <div class="text-xs text-gray-500 mt-1">${item.description}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

function toggleFormulas() {
    const content = document.getElementById('formulasContent');
    const chevron = document.getElementById('formulasChevron');

    content.classList.toggle('hidden');
    chevron.classList.toggle('rotate-180');
}
