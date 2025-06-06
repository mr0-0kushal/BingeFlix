import { asyncHandler } from '../utils/asyncHandler.js'
import { ApiError } from '../utils/ApiError.js'
import { User } from '../models/user.model.js'
import { ApiResponse } from '../utils/ApiResponse.js'
import jwt from 'jsonwebtoken'
import { client } from '../db/redis.db.js'
import { welcomeMail, sendOTPEmail } from '../utils/nodemailer.js'
// import { sendRegisterSMS } from '../utils/twilioSMS.js'
import { sendRegisterSMS, sendOTPSMS } from '../utils/fast2SMS.js'
import { generateOTP } from '../utils/otpGenerator.js'
import { uploadOnCloudinary } from '../utils/cloudinary.js'

const generateAccessAndRefreshTokens = async (userId) => {
    try {
        const user = await User.findById(userId)
        // generate access token
        const accessToken = user.generateAccessToken()
        // generate refresh token
        const refreshToken = user.generateRefreshToken()
        // update user with refresh token and save it
        user.refreshToken = refreshToken
        user.save({
            validateBeforeSave: false
        })
        // return tokens
        return { accessToken, refreshToken }
    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating tokens")
    }
}

const registerUser = asyncHandler(async (req, res) => {
    // get users details
    const { fullname, username, email, password, phone } = req.body
    // validate - not empty
    if (
        [fullname, username, email, password, phone].some((field) => field?.trim() === "")
    ) {
        return res.status(400)
            .json(
                {
                    message: "All field are required"
                },
                new ApiError(400, "All field are required")
            )
    }
    // check if user is existed already - email,username
    const existedUser = await User.findOne({
        $or: [{ username }, { email }, { phone }]
    })
    // console.log(existedUser)

    if (existedUser) {
        return res.status(409)
            .json(
                {
                    message: "User with this email or username or phone number is already existed!"
                },
                new ApiError(409, "User with this email or username or phone number is already existed!")
            )
        // throw new ApiError(409 ,"User with this email and username is already existed!")
    }

    // send mail
    const isEmailSended = await welcomeMail(email, fullname)
    // console.log(isEmailSended)
    if (!isEmailSended) {
        return res
            .status(500)
            .json({
                message: isEmailSended
            },
                new ApiError(500, {}, "Email not sended, internal server error")
            )
    }

    // const response = await sendRegisterSMS(phone, fullname)
    // if (!response.data.return) {
    //     return res.status(500)
    //         .json({
    //             message: response.data.message || "SMS sending failed"
    //         })
    // }
    // create user entry in database
    const user = User.create({
        fullname,
        username: username.toLowerCase(),
        email,
        phone,
        password,
        avatar: "https://img.myloview.com/stickers/default-avatar-profile-icon-vector-social-media-user-image-700-240336019.jpg",
        refreshToken: ""
    })

    // remove password and refresh token from response
    const userCreated = await User.findById((await user)._id).select(
        "-password -refreshToken"
    )

    // check for user creation
    if (!userCreated) {
        return res.status(500)
            .json(
                {
                    message: "Something went wrong! while registering user!"
                },
                new ApiError(500, "Something went wrong! while registering user")
            )
        //throw new ApiError(500, "Something went wrong! while registering user")
    }


    //send SMS by twilio
    // const isSMS = await sendRegisterSMS(phone,fullname)
    // console.log(isSMS)
    // if(!isSMS){
    //     throw new ApiError(500, {}, "SMS not sended, internal server error")
    // }

    // send SMS by fast2SMS

    return res.status(201).json(
        new ApiResponse(201, userCreated, "User Registered Successfully"),
        {
            // SMS: response.data,
            Email: isEmailSended
        }
    )
})

const loginUser = asyncHandler(async (req, res) => {

    // get user details
    const { email, username, password } = req.body
    // validate user details -> username or email and password
    if (!(username || email)) {
        return res.status(401)
            .json(
                {
                    message: "Username or email is required"
                },
                new ApiError(400, "Username or email is required")
            )
        // throw new ApiError(400, "Username or email is required")
    }
    // find user in database and also check if user is existed or not
    const user = await User.findOne({
        $or: [{ username }, { email }]
    })
    if (!user) {
        return res.status(400)
            .json(
                {
                    message: "User not found with this username or email"
                },
                new ApiError(400, "User not found with this username or email Password")
            )
    }
    // then , verify password and check if it is correct or not
    const isPasswordValid = await user.isPasswordCorrect(password)
    if (!isPasswordValid) {
        return res.status(401)
            .json(
                {
                    message: "Invalid Passsword"
                },
                new ApiError(401, "Invalid Password")
            )
    }
    // generate access token and refresh token
    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)

    const userLoggedIn = await User.findById(user._id).select("-password -refreshToken")
    // then , send response and set cookies
    const options = {
        httpOnly: true,
        secure: true,              // Required for HTTPS
        sameSite: 'None',          // Required for cross-site cookies
    };

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(200, {
                accessToken: accessToken,
                user: userLoggedIn
            }, "User Logged in successfully")
        )
})

const logoutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // this removes the field from document
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true,
        sameSite: 'None'
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged Out"))
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken

    if (!incomingRefreshToken) {
        throw new ApiError(401, "unauthorized request")
    }

    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )

        const user = await User.findById(decodedToken?._id)

        if (!user) {
            throw new ApiError(401, "Invalid refresh token")
        }

        if (incomingRefreshToken !== user?.refreshToken) {
            throw new ApiError(401, "Refresh token is expired or used")

        }

        const options = {
            httpOnly: true,
            secure: true
        }

        const { accessToken, newRefreshToken } = await generateAccessAndRefreshTokens(user._id)

        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", newRefreshToken, options)
            .json(
                new ApiResponse(
                    200,
                    { accessToken, refreshToken: newRefreshToken },
                    "Access token refreshed"
                )
            )
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token")
    }

})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body
    if (!(oldPassword && newPassword)) {
        throw new ApiError(400, "Both Passwords are required")
    }
    const user = await User.findById(req.user?._id)
    const isPasswordValid = await user.isPasswordCorrect(oldPassword)
    if (!isPasswordValid) {
        throw new ApiError(400, "Your Previous Password is incorrect Try Again!")
    }
    user.password = newPassword
    await user.save({ validateBeforeSave: false })

    return res.status(200)
        .json(
            new ApiResponse(200, {}, "Password Updated Successfully")
        )
})

const getCurrentUser = asyncHandler(async (req, res) => {
    const currentUser = await User.findById(req.user?._id).select("-password")
    return res.status(200).json(
        new ApiResponse(200, currentUser, "Current User Fetched Successfully")
    )
})

const updateUserDetails = asyncHandler(async (req, res) => {
    const { fullname, phone, address } = req.body
    try {
        await User.findByIdAndUpdate(
            req.user?._id,
            {
                $set: {
                    fullname,
                    phone,
                    address
                }
            },
            {
                new: true
            }
        )
    } catch (error) {
        throw new ApiError(500, error || "Problem occurred while Updating user")
    }
    return res.status(200).json(
        new ApiResponse(200, {}, "User Updated Successfully")
    )
})

const updateUserAvatar = asyncHandler(async (req, res) => {
    const localFilePath = req.file?.path
    if (!localFilePath) {
        throw new ApiError(400, "File required , Please upload the file!")
    }
    console.log(localFilePath)
    const avatar = await uploadOnCloudinary(localFilePath)
    console.log(avatar)
    if (!avatar) {
        throw new ApiError(500, "Failed uploading the image on cloudinary")
    }

    await User.findByIdAndUpdate(req.user._id,
        {
            $set: {
                avatar: avatar.url
            }
        },
        { new: true }
    )

    return res.status(200).json(
        new ApiResponse(200, { "avatarURL": avatar.url }, "Image updated successfully")
    )
})

const sendUserOTP = asyncHandler(async (req, res) => {
    const { emails, phone, username } = req.body
    if (!(emails || phone || username)) {
        return res.status(400).json(new ApiError(400, {
            message: "Email or username is required"
        }, "Username or email is required"))
    }
    const user = await User.findOne({
        $or: [{ phone }, { emails }, { username }]
    })
    if (!user) {
        return res.status(400).json(new ApiError(400, {
            message: "User not Found with this email or username"
        }, "User not found!"))
    }
    const email = user.email
    // generate OTP
    const generatedOTP = generateOTP(true, false, false, false)
    // console.log(generatedOTP)

    // storing otp to redis
    await client.set(`otp:${email}`, generatedOTP, {
        EX: 120
    })

    // Send OTP SMS
    if (phone) {
        const isSMSotp = await sendOTPSMS(phone, generatedOTP)
        if (!isSMSotp.data.return) {
            return res.status(500)
                .json({
                    message: isSMSotp.data.message || "OTP send failed"
                })
        }
    }
    // Send OTP Email
    if (email) {
        const isEmailOtp = await sendOTPEmail(email, user.fullname, generatedOTP)
        if (!isEmailOtp) {
            return res
                .status(500)
                .json({
                    message: isEmailOtp
                },
                    new ApiError(500, {}, "Email OTP not sended, internal server error")
                )
        }
    }

    return res.status(200)
        .json(
            new ApiResponse(200, {
                message: "OTP Sended Successfully",
                success: true
            }, "OTP Sended")
        )
})

const loginWithOTP = asyncHandler(async (req, res) => {
    const user = req.user
    if (!user) {
        return res.status(400)
            .json(
                new ApiError(400, {
                    message: "OTP invalid or User not found"
                }, "OTP invalid or User not found.")
            )
    }

    // generate access token and refresh token
    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)

    const userLoggedIn = await User.findById(user._id).select("-password -refreshToken")
    // then , send response and set cookies
    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(200, {
                accessToken: accessToken,
                user: userLoggedIn
            }, "User Logged in successfully")
        )

})


export {
    registerUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateUserDetails,
    updateUserAvatar,
    sendUserOTP,
    loginWithOTP
}